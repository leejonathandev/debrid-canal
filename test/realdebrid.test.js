import test from "node:test";
import assert from "node:assert/strict";
import { createRealDebridService } from "../src/services/realdebrid.js";
import { RateLimitMonitor } from "../src/services/rateLimitMonitor.js";

const response = (config, data, status = 200) => ({ config, data, status, headers: {} });

test("partial link generation retries only missing files and preserves download IDs", async () => {
  const calls = [];
  let fail = true;
  const monitor = new RateLimitMonitor();
  const service = createRealDebridService({ apiKey: "test", monitor, adapter: async config => {
    calls.push(config.url);
    if (config.url.includes("/info/")) return response(config, {
      id: "t", filename: "files", status: "downloaded", progress: 100,
      links: ["source-a", "source-b"], files: [
        { path: "/skip.txt", selected: 0 }, { path: "/a.mkv", selected: 1 }, { path: "/b.mkv", selected: 1 }
      ]
    });
    const source = new URLSearchParams(config.data).get("link");
    calls.push(source);
    if (source === "source-b" && fail) throw new Error("transient failure");
    return response(config, { id: `download-${source}`, download: `https://example.test/${source}` });
  } });
  let torrent = await service.refreshTorrentInfo({ id: "t" });
  assert.equal(torrent.linksPending, true);
  assert.deepEqual(torrent.unrestrictedLinks, [{
    name: "a.mkv", sourceLink: "source-a", url: "https://example.test/source-a", downloadId: "download-source-a"
  }]);
  fail = false;
  torrent = await service.refreshTorrentInfo(torrent);
  assert.equal(torrent.linksPending, false);
  assert.equal(torrent.unrestrictedLinks[1].name, "b.mkv");
  assert.equal(calls.filter(call => call === "source-a").length, 1);
  assert.equal(calls.filter(call => call === "source-b").length, 2);
  assert.equal(monitor.getCurrentRequestCount(), 5);
});

test("file selection retries unchanged waiting state, and old items use /info", async () => {
  const paths = [];
  const service = createRealDebridService({ apiKey: "test", monitor: new RateLimitMonitor(), adapter: async config => {
    paths.push(config.url);
    return response(config, config.url.includes("/info/")
      ? { id: "old/id", filename: "old", status: "waiting_files_selection", progress: 0, links: [] } : {});
  } });
  const first = await service.refreshTorrentInfo({ id: "old/id", status: "waiting_files_selection" });
  await service.refreshTorrentInfo(first);
  assert.equal(paths.filter(path => path === "/torrents/info/old%2Fid").length, 2);
  assert.equal(paths.filter(path => path === "/torrents/selectFiles/old%2Fid").length, 2);
});

test("a new magnet is tracked even before metadata or file selection is ready", async () => {
  const paths = [];
  const service = createRealDebridService({ apiKey: "test", adapter: async config => {
    paths.push(config.url);
    return response(config, { id: "new" }, 201);
  } });
  const added = await service.addMagnetToRealDebrid("magnet:?xt=urn:btih:test");
  assert.equal(added.id, "new");
  assert.equal(added.status, "queued");
  assert.deepEqual(paths, ["/torrents/addMagnet"]);
});

test("every service operation shares accounting and upstream 429 blocks later calls", async () => {
  const monitor = new RateLimitMonitor();
  const paths = [];
  const service = createRealDebridService({ apiKey: "test", monitor, adapter: async config => {
    paths.push(config.url);
    if (paths.length === 4) throw Object.assign(new Error("429"), { response: { status: 429, headers: { "retry-after": "90" } } });
    if (config.url === "/unrestrict/link") return response(config, { id: "d", download: "https://example.test/d" });
    return response(config, [], 204);
  } });
  await service.listTorrents();
  await service.getUnrestrictedLink("source");
  await service.deleteTorrent("t");
  await assert.rejects(service.deleteDownload("d"), error => error.status === 429);
  await assert.rejects(service.getTorrentInfo("t"), error => error.status === 429);
  assert.equal(paths.length, 4);
  assert.equal(monitor.getCurrentRequestCount(), 4);
  assert.ok(monitor.getTimeUntilReset() > 89000);
});

test("cooldown does not discard successful cached links after an earlier missing source", async () => {
  const monitor = new RateLimitMonitor();
  let calls = 0;
  const service = createRealDebridService({ apiKey: "test", monitor, adapter: async () => {
    calls++;
    throw Object.assign(new Error("429"), { response: { status: 429, headers: {} } });
  } });
  const cached = { sourceLink: "b", url: "https://example.test/b", downloadId: "db", name: "b" };
  const result = await service.getUnrestrictedLinks(["a", "b", "c"], [], [cached]);
  assert.deepEqual(result, [cached]);
  assert.equal(calls, 1);
});
