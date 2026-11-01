import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
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
  const application = createApplication({ env: { NODE_ENV: "test", REALDEBRID_API_KEY: "fake", ...overrides.env }, service });
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
  await agent.get("/api/torrents?refresh=1").expect(403);
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
  const app = createApplication({ env: { NODE_ENV: "test" }, service, monitor });
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
  const response = await agent.get("/api/torrents?refresh=1").set("CSRF-Token", csrf).expect(200);
  assert.equal(response.body[0].unrestrictedLinks[0].downloadId, "keep");
  assert.match(response.body[1].error, /retrying/);
  assert.equal((await sessions.read(id))[0].unrestrictedLinks[0].downloadId, "keep");
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
