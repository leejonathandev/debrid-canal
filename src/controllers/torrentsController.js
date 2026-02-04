import {
  addMagnetToRealDebrid,
  addTorrentToRealDebrid,
  refreshTorrentInfo
} from "../services/realdebrid.js";

const isMagnetLink = (value) =>
  typeof value === "string" && value.trim().toLowerCase().startsWith("magnet:");

const findTorrent = (req, id) =>
  req.session.torrents.find((torrent) => torrent.id === id);

export const addMagnet = async (req, res) => {
  const { magnet } = req.body;

  if (!isMagnetLink(magnet)) {
    return res.status(400).json({ error: "Invalid magnet link." });
  }

  try {
    const result = await addMagnetToRealDebrid(magnet.trim());
    const torrent = {
      id: result.id,
      inputType: "magnet",
      name: result.name || "Magnet",
      status: result.status || "queued",
      progress: result.progress ?? 0,
      addedAt: new Date().toISOString(),
      unrestrictedLink: result.unrestrictedLink || null,
      error: null
    };

    req.session.torrents.unshift(torrent);

    return res.status(201).json(torrent);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to add magnet." });
  }
};

export const addTorrentFile = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Torrent file is required." });
  }

  try {
    const result = await addTorrentToRealDebrid(req.file);
    const torrent = {
      id: result.id,
      inputType: "torrent",
      name: result.name || req.file.originalname,
      status: result.status || "queued",
      progress: result.progress ?? 0,
      addedAt: new Date().toISOString(),
      unrestrictedLink: result.unrestrictedLink || null,
      error: null
    };

    req.session.torrents.unshift(torrent);

    return res.status(201).json(torrent);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to upload torrent." });
  }
};

export const listTorrents = async (req, res) => {
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  const torrents = req.session.torrents || [];

  if (!refresh) {
    return res.json(torrents);
  }

  try {
    const refreshed = [];

    for (const torrent of torrents) {
      const updated = await refreshTorrentInfo(torrent);
      refreshed.push(updated);
    }

    req.session.torrents = refreshed;
    return res.json(refreshed);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to refresh torrents." });
  }
};

export const refreshTorrent = async (req, res) => {
  const { id } = req.params;
  const torrent = findTorrent(req, id);

  if (!torrent) {
    return res.status(404).json({ error: "Torrent not found." });
  }

  try {
    const updated = await refreshTorrentInfo(torrent);
    req.session.torrents = req.session.torrents.map((item) =>
      item.id === id ? updated : item
    );

    return res.json(updated);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to refresh torrent." });
  }
};
