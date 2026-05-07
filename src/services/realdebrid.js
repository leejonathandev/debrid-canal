import axios from "axios";
import dotenv from "dotenv";
import rateLimitMonitor from "./rateLimitMonitor.js";
import logger from "../utils/logger.js";

dotenv.config();

const API_BASE = "https://api.real-debrid.com/rest/1.0";
const API_KEY = process.env.REALDEBRID_API_KEY;
const isDebug = logger.isDebug();

if (!API_KEY) {
  logger.warn("REALDEBRID_API_KEY is not set. API calls will fail.");
}

const client = axios.create({
  baseURL: API_BASE,
  headers: {
    Authorization: `Bearer ${API_KEY}`
  },
  timeout: 30000
});

// Add response interceptor to handle rate limiting and log status codes
client.interceptors.response.use(
  (response) => {
    const method = response.config?.method?.toUpperCase() || 'REQUEST';
    const url = response.config?.url || '';
    logger.info(`[RealDebrid API] ${method} ${url} -> ${response.status}`);
    
    if (isDebug) {
      logger.debug(`[RealDebrid API DEBUG] Full response for ${url}:`);
      if (Array.isArray(response.data)) {
        logger.debug(`[RealDebrid API DEBUG] Array with ${response.data.length} items:`);
        response.data.forEach((item, index) => {
          logger.debug(`[RealDebrid API DEBUG] Item ${index}:`, JSON.stringify(item, null, 2));
        });
      } else {
        logger.debug(JSON.stringify(response.data, null, 2));
      }
    }
    
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const method = error.config?.method?.toUpperCase() || 'REQUEST';
    const url = error.config?.url || '';
    if (status) {
      logger.warn(`[RealDebrid API] ${method} ${url} -> ${status}`);
    }

    // Check for HTTP 429 rate limit error
    if (status === 429) {
      logger.error('[RealDebrid] HTTP 429 - Rate limit exceeded');
      rateLimitMonitor.markRateLimitHit();
      
      // Create a more informative error
      const rateLimitError = new Error('Rate limit exceeded. Please wait before making more requests.');
      rateLimitError.isRateLimit = true;
      rateLimitError.status = 429;
      throw rateLimitError;
    }
    
    throw error;
  }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getFileName = (filePath, fallback) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return fallback;
  }

  const segments = filePath.split("/").filter(Boolean);
  return segments[segments.length - 1] || fallback;
};

const normalizeInfo = (info) => {
  return {
    id: info.id,
    name: info.filename,
    status: info.status,
    progress: Number(info.progress || 0),
    links: Array.isArray(info.links) ? info.links : [],
    files: Array.isArray(info.files) ? info.files : []
  };
};

const normalizeListItem = (item) => {
  const normalized = {
    id: item.id,
    name: item.filename,
    status: item.status,
    progress: Number(item.progress || 0),
    links: Array.isArray(item.links) ? item.links : []
  };
  
  if (isDebug) {
    logger.debug(
      `[RealDebrid DEBUG] Normalized torrent ${item.id} (hash=${item.hash}): status=${normalized.status}, progress=${normalized.progress}`
    );
  }
  
  return normalized;
};

export const listTorrents = async ({ limit = 10 } = {}) => {
  const params = new URLSearchParams({
    limit: String(limit)
  });

  const response = await client.get(`/torrents?${params.toString()}`);

  // HTTP 204 (No Content) or empty response means no torrents
  if (response.status === 204 || !response.data) {
    if (isDebug) {
      logger.debug('[RealDebrid DEBUG] No torrents found (204 or empty response)');
    }
    return [];
  }

  if (!Array.isArray(response.data)) {
    if (isDebug) {
      logger.debug('[RealDebrid DEBUG] Response data is not an array:', typeof response.data);
    }
    return [];
  }

  return response.data.map(normalizeListItem);
};

export const addTorrentToRealDebrid = async (file) => {
  // Real-Debrid expects raw binary data, not FormData
  const response = await client.put("/torrents/addTorrent", file.buffer, {
    headers: {
      'Content-Type': 'application/x-bittorrent'
    }
  });

  const torrentId = response.data?.id;
  if (!torrentId) {
    throw new Error("RealDebrid did not return a torrent id.");
  }

  await sleep(1000);
  await selectAllFiles(torrentId);
  await sleep(1000);

  const recent = await listTorrents({ limit: 10 });
  const listItem = recent.find((item) => item.id === torrentId);

  return {
    id: torrentId,
    name: listItem?.name || file.originalname,
    status: listItem?.status || "queued",
    progress: listItem?.progress ?? 0,
    unrestrictedLink: null,
    unrestrictedLinks: []
  };
};

export const addMagnetToRealDebrid = async (magnet) => {
  const params = new URLSearchParams({ magnet });

  const response = await client.post("/torrents/addMagnet", params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  const torrentId = response.data?.id;
  if (!torrentId) {
    throw new Error("RealDebrid did not return a torrent id.");
  }

  await sleep(1000);
  await selectAllFiles(torrentId);
  await sleep(1000);

  const recent = await listTorrents({ limit: 10 });
  const listItem = recent.find((item) => item.id === torrentId);

  return {
    id: torrentId,
    name: listItem?.name || "Magnet",
    status: listItem?.status || "queued",
    progress: listItem?.progress ?? 0,
    unrestrictedLink: null,
    unrestrictedLinks: []
  };
};

export const getTorrentInfo = async (torrentId) => {
  const response = await client.get(`/torrents/info/${torrentId}`);
  return normalizeInfo(response.data);
};

export const selectAllFiles = async (torrentId) => {
  const params = new URLSearchParams({ files: "all" });

  await client.post(`/torrents/selectFiles/${torrentId}`, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
};

export const getUnrestrictedLink = async (link) => {
  const params = new URLSearchParams({ link });
  const response = await client.post("/unrestrict/link", params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  return response.data?.download || null;
};

export const getUnrestrictedLinks = async (links, files = []) => {
  if (!Array.isArray(links) || links.length === 0) {
    return [];
  }

  const unresolved = await Promise.allSettled(
    links.map((sourceLink) => getUnrestrictedLink(sourceLink))
  );

  return unresolved.flatMap((result, index) => {
    if (result.status !== "fulfilled" || !result.value) {
      return [];
    }

    return [
      {
        name: getFileName(files[index]?.path, `File ${index + 1}`),
        url: result.value
      }
    ];
  });
};

export const refreshTorrentInfo = async (torrent) => {
  const info = await getTorrentInfo(torrent.id);

  let unrestrictedLink = torrent.unrestrictedLink || null;
  let unrestrictedLinks = Array.isArray(torrent.unrestrictedLinks)
    ? torrent.unrestrictedLinks
    : [];

  if (!unrestrictedLinks.length && info.links.length) {
    if (info.status === "downloaded") {
      unrestrictedLinks = await getUnrestrictedLinks(info.links, info.files);
    }
  }

  if (!unrestrictedLink && unrestrictedLinks.length) {
    unrestrictedLink = unrestrictedLinks[0].url;
  }

  return {
    ...torrent,
    name: info.name || torrent.name,
    status: info.status,
    progress: info.progress,
    unrestrictedLink,
    unrestrictedLinks
  };
};
