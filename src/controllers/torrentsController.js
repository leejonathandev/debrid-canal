import {
  addMagnetToRealDebrid,
  addTorrentToRealDebrid,
  deleteDownload,
  deleteTorrent,
  refreshTorrentInfo
} from "../services/realdebrid.js";
import pollingService from "../services/pollingService.js";
import logger from "../utils/logger.js";

const isMagnetLink = (value) =>
  typeof value === "string" && value.trim().toLowerCase().startsWith("magnet:");

const findTorrent = (req, id) =>
  req.session.torrents.find((torrent) => torrent.id === id);

const emitSessionUpdate = (req) => {
  if (!req.io || !req.session) {
    return;
  }

  const torrents = req.session.torrents || [];
  const allComplete = torrents.every(
    (torrent) => torrent.status === "downloaded" && torrent.progress === 100
  );

  const sessionId = req.sessionID;

  req.io.to(sessionId).emit("torrents-updated", {
    torrents,
    allComplete
  });
};

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

    req.session.save((err) => {
      if (err) {
        logger.error("[Controller] Error saving session:", err);
      }
      emitSessionUpdate(req);
    });

    // Trigger polling service to start/refresh polling
    pollingService.triggerImmediatePoll();

    return res.status(201).json(torrent);
  } catch (error) {
    logger.error('[Controller] Error adding magnet:', {
      message: error.message,
      status: error.status,
      isRateLimit: error.isRateLimit,
      response: error.response?.data,
      stack: error.stack
    });
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

    req.session.save((err) => {
      if (err) {
        logger.error("[Controller] Error saving session:", err);
      }
      emitSessionUpdate(req);
    });

    // Trigger polling service to start/refresh polling
    pollingService.triggerImmediatePoll();

    return res.status(201).json(torrent);
  } catch (error) {
    logger.error('[Controller] Error uploading torrent file:', {
      message: error.message,
      status: error.status,
      isRateLimit: error.isRateLimit,
      response: error.response?.data,
      stack: error.stack
    });
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
    logger.error('[Controller] Error refreshing torrents:', {
      message: error.message,
      status: error.status,
      isRateLimit: error.isRateLimit,
      response: error.response?.data,
      stack: error.stack
    });
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

export const cancelTorrent = async (req, res) => {
  const { id } = req.params;
  const torrent = findTorrent(req, id);

  if (!torrent) {
    return res.status(404).json({ error: "Torrent not found." });
  }

  req.session.torrents = req.session.torrents.filter((item) => item.id !== id);

  req.session.save((saveError) => {
    if (saveError) {
      logger.error("[Controller] Error saving session after cancel:", saveError);
      return res.status(500).json({ error: "Failed to cancel torrent." });
    }

    emitSessionUpdate(req);
    res.status(204).send();

    Promise.resolve()
      .then(async () => {
        await deleteTorrent(id);
        if (torrent.downloadId) {
          await deleteDownload(torrent.downloadId);
        }
      })
      .catch((error) => {
        logger.warn(
          `[Controller] Session torrent removed but Real-Debrid cleanup failed for id ${id}: ${error.message}`
        );
      });

    return undefined;
  });
};
