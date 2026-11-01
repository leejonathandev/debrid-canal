import test from "node:test";
import assert from "node:assert/strict";
import session from "express-session";
import { SessionTorrents, callStore } from "../src/services/sessionTorrents.js";
import { PollingService } from "../src/services/pollingService.js";
import { RateLimitMonitor } from "../src/services/rateLimitMonitor.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, service, torrents) {
  const store = new session.MemoryStore();
  await callStore(store, "set", "s", { cookie: { expires: new Date(Date.now() + 3600000) }, torrents });
  const events = [];
  const io = { to: id => ({ emit: (event, data) => events.push({ id, event, data }) }), emit() {} };
  const sessions = new SessionTorrents(store, io);
  const poller = new PollingService({ service, monitor: new RateLimitMonitor() });
  poller.initialize(io, store, sessions);
  t.after(() => poller.stop());
  poller.start();
  return { store, sessions, poller, events };
}

test("queued and transitional torrents keep polling; completed links stop it", async t => {
  let status = "queued";
  let pending = true;
  const { sessions, poller } = await fixture(t, {
    listTorrents: async () => [],
    refreshTorrentInfo: async torrent => ({ ...torrent, status, progress: status === "downloaded" ? 100 : 0, linksPending: pending })
  }, [{ id: "t", status: "queued" }]);
  for (status of ["queued", "magnet_conversion", "waiting_files_selection", "compressing", "uploading", "downloaded"]) {
    await poller.poll();
    assert.equal(poller.isPolling, true, status);
  }
  pending = false;
  await poller.poll();
  assert.equal(poller.isPolling, false);
  assert.equal((await sessions.read("s"))[0].linksPending, false);
});

test("a listing failure falls back to info and update failures remain retryable", async t => {
  let fail = true;
  let updates = 0;
  const { poller, sessions } = await fixture(t, {
    listTorrents: async () => { throw new Error("list unavailable"); },
    refreshTorrentInfo: async (torrent, listed) => {
      assert.equal(listed, undefined);
      updates++;
      if (fail) throw new Error("info unavailable");
      return { ...torrent, status: "downloaded", progress: 100, linksPending: false };
    }
  }, [{ id: "outside-first-page", status: "queued" }]);
  await poller.poll();
  assert.equal(poller.isPolling, true);
  assert.match((await sessions.read("s"))[0].error, /retrying/);
  fail = false;
  await poller.poll();
  assert.equal(updates, 2);
  assert.equal(poller.isPolling, false);
});

test("overlapping polls coalesce and cancellation cannot be undone", async t => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const { poller, sessions, events } = await fixture(t, {
    listTorrents: async () => [],
    refreshTorrentInfo: async torrent => {
      calls++; entered.resolve(); await release.promise;
      return { ...torrent, status: "downloaded", progress: 100, linksPending: false };
    }
  }, [{ id: "cancel", status: "downloading" }]);
  const first = poller.poll();
  await entered.promise;
  assert.equal(poller.poll(), first);
  const cancel = sessions.mutate("s", torrents => torrents.filter(torrent => torrent.id !== "cancel"));
  release.resolve();
  await Promise.all([first, cancel]);
  assert.equal(calls, 1);
  assert.deepEqual(await sessions.read("s"), []);
  assert.deepEqual(events.at(-1).data.torrents, []);
});

test("concurrent additions merge, session expiry is not resurrected, and failed writes do not emit", async t => {
  const { store, sessions, events } = await fixture(t, { listTorrents: async () => [] }, []);
  await Promise.all([sessions.mutate("s", ts => [...ts, { id: "a" }]), sessions.mutate("s", ts => [...ts, { id: "b" }])]);
  assert.deepEqual((await sessions.read("s")).map(t => t.id), ["a", "b"]);
  const count = events.length;
  const originalSet = store.set;
  store.set = (_id, _session, cb) => cb(new Error("store failure"));
  await assert.rejects(sessions.mutate("s", () => []), /store failure/);
  assert.equal(events.length, count);
  store.set = originalSet;
  await assert.rejects(sessions.mutate("s", async torrents => {
    await callStore(store, "destroy", "s"); return torrents;
  }), error => error.status === 410);
  assert.equal(await callStore(store, "get", "s"), undefined);
});

test("a confirmed upstream 404 becomes terminal instead of retrying forever", async t => {
  const { poller, sessions } = await fixture(t, {
    listTorrents: async () => [],
    refreshTorrentInfo: async () => { throw Object.assign(new Error("missing"), { response: { status: 404 } }); }
  }, [{ id: "gone", status: "queued" }]);
  await poller.poll();
  assert.equal(poller.isPolling, false);
  assert.equal((await sessions.read("s"))[0].status, "dead");
});
