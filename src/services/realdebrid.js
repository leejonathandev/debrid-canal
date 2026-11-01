import axios from "axios";
import rateLimitMonitor from "./rateLimitMonitor.js";
import logger from "../utils/logger.js";

const API_BASE = "https://api.real-debrid.com/rest/1.0";
const safeId = value => encodeURIComponent(String(value || "").trim());
const fileName = (filePath, fallback) => typeof filePath === "string"
  ? filePath.split("/").filter(Boolean).at(-1) || fallback : fallback;
const normalize = info => ({
  id: info.id,
  name: info.filename,
  status: info.status,
  progress: Number(info.progress || 0),
  links: Array.isArray(info.links) ? info.links : [],
  ...(Array.isArray(info.files) ? { files: info.files } : {})
});

export function createRealDebridService({ apiKey = process.env.REALDEBRID_API_KEY, adapter, monitor = rateLimitMonitor } = {}) {
  const client = axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30000,
    ...(adapter ? { adapter } : {})
  });

  const request = config => monitor.run(async () => {
    try {
      const response = await client.request(config);
      // Never log bodies, authorization headers, source links or download URLs.
      logger.debug(`[RealDebrid] ${config.method} ${config.url.split("?")[0]} -> ${response.status}`);
      return response;
    } catch (error) {
      if (error.response?.status === 429) {
        monitor.markRateLimitHit(error.response.headers?.["retry-after"]);
        throw Object.assign(new Error("Real-Debrid request limit reached. Please try again later."), {
          status: 429, isRateLimit: true, retryAfter: Math.ceil(monitor.getTimeUntilReset() / 1000)
        });
      }
      throw error;
    }
  });
  const form = (url, values) => request({
    method: "POST", url, data: new URLSearchParams(values),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  const getTorrentInfo = async id => normalize((await request({ method: "GET", url: `/torrents/info/${safeId(id)}` })).data);
  const selectAllFiles = id => form(`/torrents/selectFiles/${safeId(id)}`, { files: "all" });
  const unrestrict = async sourceLink => {
    const response = await form("/unrestrict/link", { link: sourceLink });
    if (!response.data?.download || !/^https?:\/\//i.test(response.data.download)) {
      throw new Error("Real-Debrid did not return an HTTP download link.");
    }
    return { sourceLink, url: response.data.download, downloadId: response.data.id || null };
  };

  const getUnrestrictedLinks = async (links, files = [], existing = []) => {
    // RD's links correspond to selected files, in file order.
    const selected = files.filter(file => Number(file.selected) === 1);
    const results = [];
    let rateLimited = false;
    // Sequential per torrent; the shared monitor bounds cross-session concurrency.
    for (const [index, sourceLink] of links.entries()) {
      const cached = existing.find(item => item.sourceLink === sourceLink && item.url);
      if (cached) { results.push(cached); continue; }
      if (rateLimited) continue;
      try {
        results.push({ ...await unrestrict(sourceLink), name: fileName(selected[index]?.path, `File ${index + 1}`) });
      } catch (error) {
        logger.warn("[RealDebrid] Download link unavailable; will retry.");
        if (error.isRateLimit) rateLimited = true;
      }
    }
    return results;
  };

  const refreshTorrentInfo = async (torrent, listed) => {
    let info = listed || await getTorrentInfo(torrent.id);
    let unrestrictedLinks = torrent.unrestrictedLinks || [];
    let linksPending = true;
    if (info.status === "waiting_files_selection") {
      // Retry selection on every cycle until the upstream state changes.
      await selectAllFiles(torrent.id);
    }
    if (info.status === "downloaded") {
      if (!info.files) info = await getTorrentInfo(torrent.id);
      unrestrictedLinks = await getUnrestrictedLinks(info.links, info.files, unrestrictedLinks);
      linksPending = !info.links.length || info.links.some(link => !unrestrictedLinks.some(item => item.sourceLink === link));
    }
    return {
      ...torrent,
      name: info.name || torrent.name,
      status: info.status,
      progress: info.progress,
      unrestrictedLink: unrestrictedLinks[0]?.url || torrent.unrestrictedLink || null,
      unrestrictedLinks,
      linksPending,
      error: linksPending && info.status === "downloaded" ? "Waiting for remaining download links; retrying." : null
    };
  };

  const added = (response, name) => {
    const id = response.data?.id;
    if (!id) throw new Error("Real-Debrid did not return a torrent id.");
    // Persist the ID immediately. File selection/metadata may not be ready yet;
    // the poller owns those retries, so a later failure cannot orphan this ID.
    return { id, name, status: "queued", progress: 0, unrestrictedLink: null, unrestrictedLinks: [], linksPending: true };
  };

  return {
    listTorrents: async ({ limit = 10 } = {}) => {
      const response = await request({ method: "GET", url: `/torrents?limit=${Math.min(5000, Math.max(1, limit))}` });
      return Array.isArray(response.data) ? response.data.map(normalize) : [];
    },
    addMagnetToRealDebrid: async magnet => added(await form("/torrents/addMagnet", { magnet }), "Magnet"),
    addTorrentToRealDebrid: async file => added(await request({
      method: "PUT", url: "/torrents/addTorrent", data: file.buffer,
      headers: { "Content-Type": "application/x-bittorrent" }
    }), file.originalname),
    getTorrentInfo,
    selectAllFiles,
    getUnrestrictedLink: async link => (await unrestrict(link)).url,
    getUnrestrictedLinks,
    refreshTorrentInfo,
    deleteTorrent: async id => (await request({ method: "DELETE", url: `/torrents/delete/${safeId(id)}` })).status === 204,
    deleteDownload: async id => (await request({ method: "DELETE", url: `/downloads/delete/${safeId(id)}` })).status === 204
  };
}
