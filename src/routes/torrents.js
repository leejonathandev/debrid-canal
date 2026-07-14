import { Router } from "express";
import multer from "multer";
import {
  addMagnet,
  addTorrentFile,
  cancelTorrent,
  listTorrents,
  refreshTorrent
} from "../controllers/torrentsController.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Multer hardening: only accept actual .torrent files. Real-Debrid expects
 * raw bencoded data with Content-Type `application/x-bittorrent`. Anything
 * else is rejected before it reaches the upstream API.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const isTorrentMime = file.mimetype === "application/x-bittorrent";
    const isTorrentExt = typeof file.originalname === "string" &&
      file.originalname.toLowerCase().endsWith(".torrent");

    if (!isTorrentMime && !isTorrentExt) {
      logger.warn(`[Upload] Rejected non-torrent file: ${file.originalname} (${file.mimetype})`);
      return cb(new Error("Only .torrent files are accepted."));
    }
    cb(null, true);
  }
});

router.get("/", listTorrents);
router.delete("/:id", cancelTorrent);
router.post("/:id/refresh", refreshTorrent);
router.post("/magnet", addMagnet);
router.post("/upload", upload.single("torrent"), addTorrentFile);

export default router;
