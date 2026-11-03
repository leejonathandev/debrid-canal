import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { io as connect } from "socket.io-client";
import { SqliteSessionStore } from "../src/services/sqliteSessionStore.js";
import { callStore } from "../src/services/sessionTorrents.js";
import { createApplication } from "../src/app.js";

test("SQLite preserves metadata across reopen; stale touches cannot roll back state or revive expired sessions", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "debrid-store-"));
  let now = Date.now();
  let store = new SqliteSessionStore({ directory, now: () => now });
  t.after(async () => { await callStore(store, "close"); await rm(directory, { recursive: true, force: true }); });
  const original = { cookie: { expires: new Date(now + 1000) }, stateKey: "key", torrentRevision: 0, torrents: [] };
  await callStore(store, "set", "a", original);
  await callStore(store, "set", "b", original);
  const updated = { ...original, torrentRevision: 2, torrents: [{ id: "t", unrestrictedLinks: [{ downloadId: "download" }] }] };
  await callStore(store, "set", "a", updated);
  const touched = { ...original, cookie: { expires: new Date(now + 2000) } };
  await callStore(store, "touch", "a", touched);
  await callStore(store, "destroy", "b");
  await callStore(store, "close");
  store = new SqliteSessionStore({ directory, now: () => now });
  const persisted = await callStore(store, "get", "a");
  assert.deepEqual(persisted.torrents, updated.torrents);
  assert.equal(persisted.torrentRevision, 2);
  assert.equal(persisted.cookie.expires, touched.cookie.expires.toISOString());
  assert.equal(await callStore(store, "get", "b"), null);
  assert.equal((await stat(path.join(directory, "sessions.sqlite"))).mode & 0o777, 0o600);
  now += 3000;
  await callStore(store, "touch", "a", { ...original, cookie: { expires: new Date(now + 5000) } });
  assert.equal(await callStore(store, "get", "a"), null);
  assert.deepEqual(await callStore(store, "all"), {});
});

test("a second store cannot share the single-instance session database", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "debrid-exclusive-"));
  const first = new SqliteSessionStore({ directory });
  t.after(async () => { await callStore(first, "close"); await rm(directory, { recursive: true, force: true }); });
  assert.throws(() => new SqliteSessionStore({ directory }), /locked/);
});

test("shutdown drains an accepted upload before closing SQLite and does not restart polling", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "debrid-shutdown-"));
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const application = createApplication({ env: { NODE_ENV: "test", DATA_DIR: directory }, service: {
    addMagnetToRealDebrid: async () => { entered(); await gate; return { id: "accepted", status: "queued" }; }
  } });
  t.after(async () => {
    release();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => application.httpServer.listen(0, "127.0.0.1", resolve));
  const agent = request.agent(application.httpServer);
  const csrf = (await agent.get("/api/csrf-token").expect(200)).body.csrfToken;
  const upload = agent.post("/api/torrents/magnet").set("CSRF-Token", csrf)
    .send({ magnet: "magnet:?xt=urn:btih:shutdown" }).then(value => value);
  await started;
  const closing = application.close();
  release();
  assert.equal((await upload).status, 201);
  await closing;
  assert.equal(application.poller.isPolling, false);
  const store = new SqliteSessionStore({ directory });
  try {
    const persisted = Object.values(await callStore(store, "all"))[0];
    assert.equal(persisted.torrents[0].id, "accepted");
  } finally { await callStore(store, "close"); }
});

test("application restart retains browser ownership and CSRF, resumes pending links and preserves cancellation cleanup", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "debrid-restart-"));
  const calls = [];
  let finish = false;
  const service = {
    listTorrents: async () => [],
    addMagnetToRealDebrid: async () => ({ id: "restart", status: "queued", progress: 0, unrestrictedLinks: [] }),
    refreshTorrentInfo: async torrent => finish ? {
      ...torrent, status: "downloaded", progress: 100, linksPending: false,
      unrestrictedLinks: [{ sourceLink: "source", downloadId: "saved-download", url: "https://example.test/file" }]
    } : torrent,
    deleteTorrent: async id => calls.push(`torrent:${id}`),
    deleteDownload: async id => calls.push(`download:${id}`)
  };
  const env = { NODE_ENV: "test", SESSION_SECRET: "persistent-test-secret-".repeat(3), DATA_DIR: directory };
  let application = createApplication({ env, service });
  t.after(async () => { await application.close(); await rm(directory, { recursive: true, force: true }); });
  const listen = async () => {
    await new Promise(resolve => application.httpServer.listen(0, "127.0.0.1", resolve));
    await application.poller.inFlight;
    return `http://127.0.0.1:${application.httpServer.address().port}`;
  };
  await listen();
  const initial = await request(application.httpServer).get("/api/csrf-token").expect(200);
  const cookie = initial.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  await request(application.httpServer).post("/api/torrents/magnet").set("Cookie", cookie)
    .set("CSRF-Token", initial.body.csrfToken).send({ magnet: "magnet:?xt=urn:btih:test" }).expect(201);
  await application.poller.inFlight;
  const before = (await request(application.httpServer).get("/api/torrents/state").set("Cookie", cookie).expect(200)).body;
  await application.close();
  finish = true;
  application = createApplication({ env, service });
  const url = await listen();
  // No browser request was needed to resume the stored queue.
  const stored = Object.values(await callStore(application.sessionStore, "all"))[0];
  assert.equal(stored.torrents[0].status, "downloaded");
  assert.equal(application.poller.isPolling, false);
  assert.ok(stored.torrentRevision > before.revision);
  const socket = connect(url, { transports: ["websocket"], reconnection: false, extraHeaders: { Cookie: cookie } });
  t.after(() => socket.disconnect());
  const live = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No persisted socket state")), 3000);
    socket.once("connect_error", error => { clearTimeout(timeout); reject(error); });
    socket.once("torrents-updated", data => { clearTimeout(timeout); resolve(data); });
  });
  assert.equal(live.sessionKey, before.sessionKey);
  assert.equal(live.torrents[0].unrestrictedLinks[0].downloadId, "saved-download");
  assert.deepEqual((await request(application.httpServer).get("/api/torrents").expect(200)).body, []);
  await request(application.httpServer).delete("/api/torrents/restart").set("Cookie", cookie)
    .set("CSRF-Token", initial.body.csrfToken).expect(204);
  assert.deepEqual(calls, ["torrent:restart", "download:saved-download"]);
  socket.disconnect();
  await application.close();
  application = createApplication({ env, service });
  await listen();
  assert.deepEqual((await request(application.httpServer).get("/api/torrents").set("Cookie", cookie).expect(200)).body, []);
});
