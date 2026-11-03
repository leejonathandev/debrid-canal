import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSessionClient, TorrentState } from "../public/session-client.js";

const snapshot = (revision, torrents = [], sessionKey = "session-a") => ({ sessionKey, revision, torrents });
const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" }
});
const bootstrap = (state = snapshot(0), csrfToken = "first") => json({ csrfToken, state });
const rejectedCsrf = () => json({ error: "Invalid CSRF token", code: "EBADCSRFTOKEN" }, 403);
class Socket extends EventEmitter {
  connected = false;
  connections = 0;
  connect() { this.connections++; }
  disconnect() { this.connected = false; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("late upload responses and old HTTP snapshots cannot undo completion or cancellation", async () => {
  const socket = new Socket();
  const states = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const queued = { id: "t", status: "queued", progress: 0, unrestrictedLinks: [] };
  const completed = { ...queued, status: "downloaded", progress: 100, unrestrictedLinks: [{ url: "https://example.test/file" }] };
  const client = createSessionClient({ socket, onState: state => states.push(state), fetch: async url => {
    if (url === "/api/csrf-token") return bootstrap();
    if (url === "/upload") return delayed;
    return json(snapshot(1, [queued]));
  } });
  await client.start();
  const upload = client.mutate("/upload", { method: "POST" });
  socket.emit("torrents-updated", snapshot(2, [completed]));
  release(json(queued, 201));
  await upload;
  assert.deepEqual(states.at(-1).torrents, [completed]);
  socket.emit("torrents-updated", snapshot(3));
  await client.refreshState();
  assert.deepEqual(states.at(-1).torrents, []);
  assert.equal(states.at(-1).revision, 3);
});

test("old-session events cannot replace a freshly recovered session", () => {
  const states = [];
  const state = new TorrentState(value => states.push(value));
  state.activate(snapshot(9, [{ id: "old" }]));
  state.activate(snapshot(0, [], "session-b"));
  state.apply(snapshot(10, [{ id: "old" }]));
  assert.deepEqual(states.at(-1), snapshot(0, [], "session-b"));
});

test("CSRF expiry renews the token and retries a rejected mutation exactly once", async () => {
  const socket = new Socket();
  const tokens = [];
  let renewals = 0;
  const client = createSessionClient({ socket, fetch: async (url, options) => {
    if (url === "/api/csrf-token") return bootstrap(snapshot(0), `token-${++renewals}`);
    if (url === "/api/torrents/state") return json(snapshot(1));
    tokens.push(options.headers["CSRF-Token"]);
    return tokens.length === 1 ? rejectedCsrf() : json({ id: "t" }, 201);
  } });
  await client.start();
  await client.mutate("/upload", { method: "POST" });
  assert.deepEqual(tokens, ["token-1", "token-2"]);
  assert.equal(renewals, 2);
});

test("mutation retries are bounded and never replay ambiguous failures or other 403 responses", async () => {
  for (const failure of [rejectedCsrf, () => json({ error: "Access denied" }, 403),
    () => json({ error: "Upstream failed" }, 502), () => { throw new TypeError("Network failed"); }]) {
    let attempts = 0;
    const client = createSessionClient({ socket: new Socket(), fetch: async url => {
      if (url === "/api/csrf-token") return bootstrap();
      attempts++;
      return failure();
    } });
    await assert.rejects(client.mutate("/upload", { method: "POST" }));
    assert.equal(attempts, failure === rejectedCsrf ? 2 : 1);
  }
});

test("concurrent CSRF rejections share one renewal", async () => {
  let renewals = 0;
  let attempts = 0;
  const client = createSessionClient({ socket: new Socket(), fetch: async (url, options) => {
    if (url === "/api/csrf-token") { renewals++; await flush(); return bootstrap(snapshot(0), `token-${renewals}`); }
    if (url === "/api/torrents/state") return json(snapshot(1));
    attempts++;
    return options.headers["CSRF-Token"] === "token-1" ? rejectedCsrf() : json(null, 204);
  } });
  await client.start();
  await Promise.all([1, 2].map(() => client.mutate("/delete", { method: "DELETE" })));
  assert.equal(renewals, 2);
  assert.equal(attempts, 4);
});

test("socket session rejection bootstraps once, reconnects and accepts recovered state", async () => {
  const socket = new Socket();
  let bootstraps = 0;
  const states = [];
  const statuses = [];
  const client = createSessionClient({ socket, onState: value => states.push(value), onStatus: value => statuses.push(value),
    fetch: async () => bootstrap(snapshot(0, [], `session-${++bootstraps}`)) });
  await client.start();
  socket.emit("connect_error", { data: { code: "SESSION_REQUIRED" } });
  await flush();
  assert.equal(socket.connections, 2);
  assert.equal(states.at(-1).sessionKey, "session-2");
  socket.emit("connect_error", { data: { code: "SESSION_REQUIRED" } });
  await flush();
  assert.equal(bootstraps, 2);
  assert.match(statuses.at(-1), /Reload/);
});

test("failed initialization remains retryable and OAuth HTML produces a useful sign-in message", async () => {
  let requests = 0;
  const client = createSessionClient({ socket: new Socket(), fetch: async url => {
    requests++;
    if (requests === 1) return new Response("Sign in", { headers: { "Content-Type": "text/html" } });
    if (url === "/api/csrf-token") return bootstrap();
    if (url === "/api/torrents/state") return json(snapshot(1));
    return json({ id: "t" }, 201);
  } });
  await assert.rejects(client.start(), /Reload the page to sign in/);
  await client.mutate("/upload", { method: "POST" });
  assert.equal(requests, 4);
});
