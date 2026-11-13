import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import request from "supertest";
import session from "express-session";
import { io as connect } from "socket.io-client";
import { createApplication } from "../src/app.js";
import { createRealDebridService } from "../src/services/realdebrid.js";
import { RateLimitMonitor } from "../src/services/rateLimitMonitor.js";
import { resolveSessionSecret, resolveTrustProxy } from "../src/config.js";
import { callStore } from "../src/services/sessionTorrents.js";

function setup(t, overrides = {}) {
  const calls = [];
  const service = {
    listTorrents: async () => [],
    addMagnetToRealDebrid: async () => ({ id: "magnet", status: "queued", progress: 0, unrestrictedLinks: [] }),
    addTorrentToRealDebrid: async () => ({ id: "file", status: "queued", progress: 0, unrestrictedLinks: [] }),
    refreshTorrentInfo: async torrent => ({ ...torrent, status: "downloaded", progress: 100, linksPending: false }),
    deleteTorrent: async id => { calls.push(`torrent:${id}`); },
    deleteDownload: async id => { calls.push(`download:${id}`); },
    ...overrides.service
  };
  const application = createApplication({ env: { NODE_ENV: "test", REALDEBRID_API_KEY: "fake", ...overrides.env },
    service, sessionStore: new session.MemoryStore() });
  // Controller tests explicitly control background work. Polling has its own suite.
  application.poller.triggerImmediatePoll = async () => {};
  t.after(() => application.close());
  return { ...application, agent: request.agent(application.httpServer), calls, service };
}
const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
async function token(agent) { return (await agent.get("/api/csrf-token").expect(200)).body.csrfToken; }

async function listen(httpServer) {
  await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${httpServer.address().port}`;
}

async function socketState(t, url, cookie, transports = ["websocket"]) {
  const socket = connect(url, { transports, reconnection: false, extraHeaders: { Cookie: cookie } });
  t.after(() => socket.disconnect());
  const state = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket state timed out")), 3000);
    socket.once("connect_error", error => { clearTimeout(timeout); reject(error); });
    socket.once("torrents-updated", state => { clearTimeout(timeout); resolve(state); });
  });
  return { socket, state };
}

test("CSRF rejects missing, query-only and foreign-session tokens; valid upload/delete and session isolation work", async t => {
  const { agent, httpServer, calls } = setup(t);
  const csrf = await token(agent);
  await agent.post("/api/torrents/magnet").send({ magnet }).expect(403);
  await agent.post("/api/torrents/refresh").expect(403);
  await agent.post(`/api/torrents/magnet?_csrf=${encodeURIComponent(csrf)}`).send({ magnet }).expect(403);
  await request(httpServer).post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(403);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(201);
  assert.equal((await agent.get("/api/torrents").expect(200)).body.length, 1);
  assert.deepEqual((await request(httpServer).get("/api/torrents").expect(200)).body, []);
  await request(httpServer).delete("/api/torrents/magnet").expect(403);
  await agent.post("/api/torrents/upload").set("CSRF-Token", csrf)
    .attach("torrent", Buffer.from("d4:infodee"), "sample.torrent").expect(201);
  await agent.delete("/api/torrents/magnet").set("CSRF-Token", csrf).expect(204);
  assert.deepEqual(calls, ["torrent:magnet"]);
  assert.deepEqual((await agent.get("/api/torrents")).body.map(torrent => torrent.id), ["file"]);
});

test("invalid, missing and oversized uploads return structured JSON errors", async t => {
  const { agent } = setup(t);
  const csrf = await token(agent);
  const missing = await agent.post("/api/torrents/upload").set("CSRF-Token", csrf).expect(400);
  assert.match(missing.body.error, /required/);
  const invalid = await agent.post("/api/torrents/upload").set("CSRF-Token", csrf)
    .attach("torrent", Buffer.from("not a torrent"), "file.txt").expect(400);
  assert.match(invalid.body.error, /torrent/);
  const large = await agent.post("/api/torrents/upload").set("CSRF-Token", csrf)
    .attach("torrent", Buffer.alloc(50 * 1024 * 1024 + 1), "large.torrent").expect(413);
  assert.match(large.body.error, /50 MB/);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet: "magnet:?xt=" + "a".repeat(8192) }).expect(400);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet: "magnet:" }).expect(400);
  const malformed = await agent.post("/api/torrents/magnet").set("Content-Type", "application/json").send("{").expect(400);
  assert.equal(typeof malformed.body.error, "string");
});

test("production secrets reject missing/default values and cookie flags respect Traefik HTTPS", async t => {
  for (const value of [undefined, "change_me", "debrid-canal-secret", "short", "change_me".repeat(8)]) {
    assert.throws(() => resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: value }), /SESSION_SECRET/);
  }
  assert.notEqual(resolveSessionSecret({}), resolveSessionSecret({}));
  assert.throws(() => resolveTrustProxy("true"), /TRUST_PROXY/);
  const { httpServer } = setup(t, { env: { NODE_ENV: "production", SESSION_SECRET: "a".repeat(64), TRUST_PROXY: "1" } });
  const response = await request(httpServer).get("/api/csrf-token").set("X-Forwarded-Proto", "https").expect(200);
  const cookies = response.headers["set-cookie"];
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
  }
  const rawCookies = cookies.map(cookie => cookie.split(";")[0]).join("; ");
  await request(httpServer).post("/api/torrents/magnet").set("X-Forwarded-Proto", "https")
    .set("Cookie", rawCookies).set("CSRF-Token", response.body.csrfToken).send({ magnet }).expect(201);
  await request(httpServer).delete("/api/torrents/magnet").set("X-Forwarded-Proto", "https")
    .set("Cookie", rawCookies).set("CSRF-Token", response.body.csrfToken).expect(204);
});

test("API and CSRF limits reject excess requests before upstream work", async t => {
  const csrfApp = setup(t, { env: { RATE_LIMIT_CSRF: "1" } });
  await csrfApp.agent.get("/api/csrf-token").expect(200);
  const limited = await csrfApp.agent.get("/api/csrf-token").expect(429);
  assert.equal(typeof limited.body.error, "string");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  const apiApp = setup(t, { env: { RATE_LIMIT_API: "1" } });
  await apiApp.agent.get("/api/torrents").expect(200);
  await apiApp.agent.get("/api/torrents").expect(429);
});

test("deletion cleans every download ID; failed cleanup stays retryable without leaking errors", async t => {
  let fail = true;
  const { agent, sessions, sessionStore, calls } = setup(t, { service: {
    deleteDownload: async id => { if (fail) throw new Error("secret upstream details"); calls.push(`download:${id}`); }
  } });
  const csrf = await token(agent);
  const stored = await callStore(sessionStore, "all");
  const id = Object.keys(stored)[0];
  await sessions.mutate(id, () => [{ id: "t", downloadId: "legacy", unrestrictedLinks: [
    { downloadId: "a" }, { downloadId: "b" }, { downloadId: "a" }
  ] }]);
  const failed = await agent.delete("/api/torrents/t").set("CSRF-Token", csrf).expect(500);
  assert.doesNotMatch(failed.body.error, /secret/);
  assert.equal((await sessions.read(id)).length, 1);
  fail = false;
  await agent.delete("/api/torrents/t").set("CSRF-Token", csrf).expect(204);
  assert.deepEqual(calls, ["torrent:t", "torrent:t", "download:legacy", "download:a", "download:b"]);
  assert.deepEqual(await sessions.read(id), []);
});

test("simultaneous HTTP uploads do not overwrite each other during response finalization", async t => {
  let count = 0;
  const { agent } = setup(t, { service: {
    addMagnetToRealDebrid: async () => ({ id: `item-${++count}`, status: "queued", unrestrictedLinks: [] })
  } });
  const csrf = await token(agent);
  await Promise.all([1, 2, 3].map(() => agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(201)));
  assert.equal((await agent.get("/api/torrents").expect(200)).body.length, 3);
});

test("repeat submissions preserve a tracked torrent and its download cleanup IDs", async t => {
  const { agent, calls } = setup(t, { service: {
    addTorrentToRealDebrid: async () => ({ id: "magnet", status: "queued", progress: 0 }),
    refreshTorrentInfo: async torrent => ({
      ...torrent, status: "downloaded", progress: 100, linksPending: false,
      downloadId: "legacy", unrestrictedLink: "https://example.test/legacy",
      unrestrictedLinks: [{ downloadId: "file-a", url: "https://example.test/a" }]
    })
  } });
  const csrf = await token(agent);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(201);
  const completed = (await agent.post("/api/torrents/magnet/refresh").set("CSRF-Token", csrf).expect(200)).body;
  const repeatedMagnet = await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(201);
  const repeatedFile = await agent.post("/api/torrents/upload").set("CSRF-Token", csrf)
    .attach("torrent", Buffer.from("d4:infodee"), "repeat.torrent").expect(201);
  assert.deepEqual(repeatedMagnet.body, completed);
  assert.deepEqual(repeatedFile.body, completed);
  assert.deepEqual((await agent.get("/api/torrents").expect(200)).body, [completed]);
  await agent.delete("/api/torrents/magnet").set("CSRF-Token", csrf).expect(204);
  assert.deepEqual(calls, ["torrent:magnet", "download:legacy", "download:file-a"]);
});

test("HTTP cancellation waits for an in-flight refresh and removes newly created download IDs", async t => {
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { agent, sessions, sessionStore, calls } = setup(t, { service: {
    refreshTorrentInfo: async torrent => {
      entered(); await gate;
      return { ...torrent, status: "downloaded", unrestrictedLinks: [{ downloadId: "new-d" }], linksPending: false };
    }
  } });
  const csrf = await token(agent);
  const id = Object.keys(await callStore(sessionStore, "all"))[0];
  await sessions.mutate(id, () => [{ id: "t", status: "downloading" }]);
  const refresh = agent.post("/api/torrents/t/refresh").set("CSRF-Token", csrf).then(response => response);
  await ready;
  const cancel = agent.delete("/api/torrents/t").set("CSRF-Token", csrf).then(response => response);
  release();
  assert.equal((await refresh).status, 200);
  assert.equal((await cancel).status, 204);
  assert.deepEqual(calls, ["torrent:t", "download:new-d"]);
  assert.deepEqual((await agent.get("/api/torrents")).body, []);
});

test("websocket and polling connections use the HTTP session and receive only their room", async t => {
  const { httpServer, sessions, sessionStore } = setup(t);
  const url = await listen(httpServer);
  const first = await request(httpServer).get("/api/csrf-token").expect(200);
  const firstCookie = first.headers["set-cookie"].map(cookie => cookie.split(";")[0]).join("; ");
  const id = Object.keys(await callStore(sessionStore, "all"))[0];
  await sessions.mutate(id, () => [{ id: "private" }]);
  const second = await request(httpServer).get("/api/csrf-token").expect(200);
  const secondCookie = second.headers["set-cookie"].map(cookie => cookie.split(";")[0]).join("; ");
  const a = await socketState(t, url, firstCookie);
  const b = await socketState(t, url, secondCookie, ["polling"]);
  assert.equal(a.state.torrents[0].id, "private");
  assert.deepEqual(b.state.torrents, []);
  const event = new Promise(resolve => a.socket.once("torrents-updated", resolve));
  let leaked = false;
  b.socket.on("torrents-updated", () => { leaked = true; });
  await sessions.mutate(id, () => [{ id: "updated-private" }]);
  assert.equal((await event).torrents[0].id, "updated-private");
  // A shared Engine.IO ping gives the other transport a turn to process packets.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(leaked, false);
  a.socket.disconnect();
  b.socket.disconnect();
});

test("HTTP and WebSocket reads return saved state while a poll waits on Real-Debrid", { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { agent, httpServer, poller } = setup(t, { service: {
    refreshTorrentInfo: async torrent => {
      entered.resolve();
      await release.promise;
      return { ...torrent, status: "downloading", progress: 50 };
    }
  } });
  const url = await listen(httpServer);
  const first = await agent.get("/api/csrf-token").expect(200);
  const cookie = first.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  await agent.post("/api/torrents/magnet").set("CSRF-Token", first.body.csrfToken).send({ magnet }).expect(201);
  const before = (await agent.get("/api/torrents/state").expect(200)).body;
  const polling = poller.poll();
  try {
    await entered.promise;
    const [list, state, bootstrap, live] = await Promise.all([
      agent.get("/api/torrents").timeout(3000).expect(200),
      agent.get("/api/torrents/state").timeout(3000).expect(200),
      agent.get("/api/csrf-token").timeout(3000).expect(200),
      socketState(t, url, cookie)
    ]);
    assert.deepEqual(list.body, before.torrents);
    assert.deepEqual(state.body, before);
    assert.deepEqual(bootstrap.body.state, before);
    assert.deepEqual(live.state, before);

    const updated = once(live.socket, "torrents-updated", { signal: AbortSignal.timeout(3000) });
    release.resolve();
    const [snapshot] = await updated;
    assert.equal(snapshot.revision, before.revision + 1);
    assert.equal(snapshot.torrents[0].progress, 50);
    live.socket.disconnect();
  } finally {
    release.resolve();
    await polling;
  }
});

test("Socket.IO refuses clients without a pre-established HTTP session", async t => {
  const { httpServer } = setup(t);
  const url = await listen(httpServer);
  const socket = connect(url, { transports: ["websocket"], reconnection: false });
  t.after(() => socket.disconnect());
  const error = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expected socket rejection")), 3000);
    socket.once("connect_error", error => { clearTimeout(timeout); resolve(error); });
  });
  assert.match(error.message, /Session required/);
});

test("full application integration saves partial links, retries the remainder and cleans their downloads", async t => {
  const paths = [];
  let transient = true;
  const monitor = new RateLimitMonitor();
  const service = createRealDebridService({ apiKey: "fake", monitor, adapter: async config => {
    paths.push(config.url);
    let data;
    if (config.url === "/torrents/addMagnet") data = { id: "integration" };
    else if (config.url.startsWith("/torrents?")) data = [{ id: "integration", filename: "bundle", status: "downloaded", progress: 100, links: ["a", "b"] }];
    else if (config.url.includes("/info/")) data = { id: "integration", filename: "bundle", status: "downloaded", progress: 100, links: ["a", "b"], files: [{ path: "/a", selected: 1 }, { path: "/b", selected: 1 }] };
    else if (config.url === "/unrestrict/link") {
      const source = new URLSearchParams(config.data).get("link");
      if (source === "b" && transient) throw new Error("temporary");
      data = { id: `download-${source}`, download: `https://example.test/${source}` };
    }
    return { config, data, status: config.method === "delete" ? 204 : 200, headers: {} };
  } });
  const app = createApplication({ env: { NODE_ENV: "test" }, service, monitor, sessionStore: new session.MemoryStore() });
  t.after(() => app.close());
  const agent = request.agent(app.httpServer);
  const csrf = await token(agent);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", csrf).send({ magnet }).expect(201);
  await app.poller.poll();
  let torrents = (await agent.get("/api/torrents")).body;
  assert.equal(torrents[0].unrestrictedLinks.length, 1);
  assert.equal(app.poller.isPolling, true);
  transient = false;
  await app.poller.poll();
  torrents = (await agent.get("/api/torrents")).body;
  assert.equal(torrents[0].unrestrictedLinks.length, 2);
  assert.equal(app.poller.isPolling, false);
  await agent.delete("/api/torrents/integration").set("CSRF-Token", csrf).expect(204);
  assert.ok(paths.includes("/downloads/delete/download-a"));
  assert.ok(paths.includes("/downloads/delete/download-b"));
});

test("bulk refresh persists successful download metadata when another torrent fails", async t => {
  const { agent, sessionStore, sessions } = setup(t, { service: {
    refreshTorrentInfo: async torrent => {
      if (torrent.id === "fail") throw new Error("upstream unavailable");
      return { ...torrent, unrestrictedLinks: [{ sourceLink: "a", downloadId: "keep", url: "https://example.test/a" }] };
    }
  } });
  const csrf = await token(agent);
  const id = Object.keys(await callStore(sessionStore, "all"))[0];
  await sessions.mutate(id, () => [{ id: "ok" }, { id: "fail" }]);
  const response = await agent.post("/api/torrents/refresh").set("CSRF-Token", csrf).expect(200);
  assert.equal(response.body[0].unrestrictedLinks[0].downloadId, "keep");
  assert.match(response.body[1].error, /retrying/);
  assert.equal((await sessions.read(id))[0].unrestrictedLinks[0].downloadId, "keep");
});

test("GET and HEAD stay read-only even with legacy refresh flags; POST requires CSRF", async t => {
  let refreshes = 0;
  const { agent, sessionStore, sessions } = setup(t, { service: {
    refreshTorrentInfo: async torrent => { refreshes++; return torrent; }
  } });
  const csrf = await token(agent);
  const id = Object.keys(await callStore(sessionStore, "all"))[0];
  await sessions.mutate(id, () => [{ id: "t", status: "queued" }]);
  const before = await sessions.snapshot(id);
  for (const flag of ["1", "true"]) {
    await agent.get(`/api/torrents?refresh=${flag}`).expect(200);
    await agent.head(`/api/torrents?refresh=${flag}`).expect(200);
  }
  await agent.post("/api/torrents/refresh").expect(403);
  assert.equal(refreshes, 0);
  assert.deepEqual(await sessions.snapshot(id), before);
  await agent.post("/api/torrents/refresh").set("CSRF-Token", csrf).expect(200);
  assert.equal(refreshes, 1);
  const state = (await agent.get("/api/torrents/state").expect(200)).body;
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.sessionKey, before.sessionKey);
});

test("an expired session can bootstrap fresh CSRF and reconnect without reusing the old room", async t => {
  const { agent, httpServer, sessionStore } = setup(t);
  const url = await listen(httpServer);
  const first = await agent.get("/api/csrf-token").expect(200);
  await callStore(sessionStore, "clear");
  const rejected = await agent.post("/api/torrents/magnet").set("CSRF-Token", first.body.csrfToken).send({ magnet }).expect(403);
  assert.equal(rejected.body.code, "EBADCSRFTOKEN");
  const renewed = await agent.get("/api/csrf-token").expect(200);
  assert.notEqual(renewed.body.state.sessionKey, first.body.state.sessionKey);
  await agent.post("/api/torrents/magnet").set("CSRF-Token", renewed.body.csrfToken).send({ magnet }).expect(201);
  const cookie = renewed.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  const connected = await socketState(t, url, cookie);
  assert.equal(connected.state.sessionKey, renewed.body.state.sessionKey);
  assert.equal(connected.state.torrents[0].id, "magnet");
  connected.socket.disconnect();
});

test("a malformed compressed request returns JSON and leaves the server healthy", async t => {
  const { gzipSync } = await import("node:zlib");
  const { agent } = setup(t);
  const body = Buffer.concat([gzipSync(Buffer.from('{"magnet":"test"}')), Buffer.from("trailing-invalid-bytes")]);
  const result = await agent.post("/api/torrents/magnet")
    .set("Content-Type", "application/json").set("Content-Encoding", "gzip").send(body);
  assert.ok(result.status >= 400 && result.status < 500);
  assert.equal(typeof result.body.error, "string");
  await agent.get("/health").expect(200);
});
