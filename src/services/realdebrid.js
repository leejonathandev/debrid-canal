import axios from "axios";
import dotenv from "dotenv";
import rateLimitMonitor from "./rateLimitMonitor.js";

dotenv.config();

const API_BASE = "https://api.real-debrid.com/rest/1.0";
const API_KEY = process.env.REALDEBRID_API_KEY;

if (!API_KEY) {
  // eslint-disable-next-line no-console
  console.warn("REALDEBRID_API_KEY is not set. API calls will fail.");
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
    console.log(`[RealDebrid API] ${method} ${url} -> ${response.status}`);
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const method = error.config?.method?.toUpperCase() || 'REQUEST';
    const url = error.config?.url || '';
    if (status) {
      console.warn(`[RealDebrid API] ${method} ${url} -> ${status}`);
    }

    // Check for HTTP 429 rate limit error
    if (status === 429) {
      console.error('[RealDebrid] HTTP 429 - Rate limit exceeded');
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
  return {
    id: item.id,
    name: item.filename,
    status: item.status,
    progress: Number(item.progress || 0),
    links: Array.isArray(item.links) ? item.links : []
  };
};

export const listTorrents = async ({ offset = 0, limit = 100, filter } = {}) => {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit)
  });

  if (filter) {
    params.set("filter", filter);
  }

  const response = await client.get(`/torrents?${params.toString()}`);

  if (!Array.isArray(response.data)) {
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

  const info = await getTorrentInfo(torrentId);
  const selectedInfo = await selectAllFilesIfNeeded(torrentId, info);

  let unrestrictedLink = null;
  if (selectedInfo.status === "downloaded" && selectedInfo.links.length) {
    unrestrictedLink = await getUnrestrictedLink(selectedInfo.links[0]);
  }

  return {
    id: torrentId,
    name: selectedInfo.name,
    status: selectedInfo.status,
    progress: selectedInfo.progress,
    unrestrictedLink
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

  const info = await getTorrentInfo(torrentId);
  const selectedInfo = await selectAllFilesIfNeeded(torrentId, info);

  let unrestrictedLink = null;
  if (selectedInfo.status === "downloaded" && selectedInfo.links.length) {
    unrestrictedLink = await getUnrestrictedLink(selectedInfo.links[0]);
  }

  return {
    id: torrentId,
    name: selectedInfo.name,
    status: selectedInfo.status,
    progress: selectedInfo.progress,
    unrestrictedLink
  };
};

export const getTorrentInfo = async (torrentId) => {
  const response = await client.get(`/torrents/info/${torrentId}`);
  return normalizeInfo(response.data);
};

export const selectAllFilesIfNeeded = async (torrentId, info) => {
  if (info.status !== "waiting_files_selection") {
    return info;
  }

  if (!info.files.length) {
    return info;
  }

  const fileIds = info.files.map((file) => file.id).join(",");
  const params = new URLSearchParams({ files: fileIds });

  await client.post(`/torrents/selectFiles/${torrentId}`, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  const refreshed = await getTorrentInfo(torrentId);
  return refreshed;
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

export const refreshTorrentInfo = async (torrent) => {
  const info = await getTorrentInfo(torrent.id);
  const selectedInfo = await selectAllFilesIfNeeded(torrent.id, info);

  let unrestrictedLink = torrent.unrestrictedLink || null;

  if (!unrestrictedLink && selectedInfo.links.length) {
    if (selectedInfo.status === "downloaded") {
      unrestrictedLink = await getUnrestrictedLink(selectedInfo.links[0]);
    }
  }

  return {
    ...torrent,
    name: selectedInfo.name || torrent.name,
    status: selectedInfo.status,
    progress: selectedInfo.progress,
    unrestrictedLink
  };
};
