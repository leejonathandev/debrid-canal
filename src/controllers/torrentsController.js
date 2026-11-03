import logger from "../utils/logger.js";

const notFound = () => Object.assign(new Error("Torrent not found."), { status: 404 });
const isMagnetLink = value => typeof value === "string" && Buffer.byteLength(value.trim()) <= 8192 &&
  /^magnet:\?/i.test(value.trim()) && new URLSearchParams(value.trim().slice(8)).has("xt");

export function createTorrentsController({ service, sessions, poller }) {
  const add = async (req, res, inputType, operation) => {
    let torrent;
    await sessions.mutate(req.sessionID, async torrents => {
      const result = await operation();
      torrent = {
        ...result, inputType, addedAt: new Date().toISOString(), error: null
      };
      // Some magnets resolve to an existing account torrent ID.
      return [torrent, ...torrents.filter(item => item.id !== torrent.id)];
    });
    void poller.triggerImmediatePoll();
    res.status(201).json(torrent);
  };

  return {
    addMagnet: async (req, res) => {
      if (!isMagnetLink(req.body?.magnet)) return res.status(400).json({ error: "Invalid magnet link (maximum 8 KB)." });
      await add(req, res, "magnet", () => service.addMagnetToRealDebrid(req.body.magnet.trim()));
    },
    addTorrentFile: async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Torrent file is required." });
      await add(req, res, "torrent", () => service.addTorrentToRealDebrid(req.file));
    },
    listTorrents: async (req, res) => {
      // GET (including Express's implicit HEAD) never performs upstream writes.
      res.json(await sessions.read(req.sessionID));
    },
    getState: async (req, res) => res.json(await sessions.snapshot(req.sessionID)),
    refreshTorrents: async (req, res) => {
      await sessions.mutate(req.sessionID, async torrents => {
        const updated = [];
        for (const torrent of torrents) {
          try { updated.push(await service.refreshTorrentInfo(torrent)); }
          catch {
            // Commit successful links even if another torrent is unavailable.
            updated.push({ ...torrent, error: "Update failed; retrying." });
          }
        }
        return updated;
      });
      void poller.triggerImmediatePoll();
      res.json(await sessions.read(req.sessionID));
    },
    refreshTorrent: async (req, res) => {
      let updated;
      await sessions.mutate(req.sessionID, async torrents => {
        const torrent = torrents.find(item => item.id === req.params.id);
        if (!torrent) throw notFound();
        updated = await service.refreshTorrentInfo(torrent);
        return torrents.map(item => item.id === updated.id ? updated : item);
      });
      void poller.triggerImmediatePoll();
      res.json(updated);
    },
    cancelTorrent: async (req, res) => {
      await sessions.mutate(req.sessionID, async torrents => {
        const torrent = torrents.find(item => item.id === req.params.id);
        if (!torrent) throw notFound();
        // Delete while holding the same lock as refresh, so no newly generated
        // download IDs can escape cleanup. Failures leave the item retryable.
        try { await service.deleteTorrent(torrent.id); }
        catch (error) { if (error.response?.status !== 404) throw error; }
        const downloadIds = new Set([
          torrent.downloadId,
          ...(torrent.unrestrictedLinks || []).map(link => link.downloadId)
        ].filter(Boolean));
        for (const id of downloadIds) {
          try { await service.deleteDownload(id); }
          catch (error) {
            if (error.response?.status !== 404) {
              logger.warn("[Controller] Download cleanup failed; removal can be retried.");
              throw error;
            }
          }
        }
        return torrents.filter(item => item.id !== torrent.id);
      });
      res.status(204).end();
    }
  };
}
