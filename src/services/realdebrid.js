import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";

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

export const addTorrentToRealDebrid = async (file) => {
  const form = new FormData();
  form.append("file", file.buffer, file.originalname);

  const response = await client.post("/torrents/addTorrent", form, {
    headers: {
      ...form.getHeaders()
    }
  });

  const torrentId = response.data?.id;
  if (!torrentId) {
    throw new Error("RealDebrid did not return a torrent id.");
  }

  const info = await getTorrentInfo(torrentId);
  const selectedInfo = await selectAllFilesIfNeeded(torrentId, info);

  return {
    id: torrentId,
    name: selectedInfo.name,
    status: selectedInfo.status,
    progress: selectedInfo.progress
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

  return {
    id: torrentId,
    name: selectedInfo.name,
    status: selectedInfo.status,
    progress: selectedInfo.progress
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
