import { Router } from "express";
import multer from "multer";
import {
  addMagnet,
  addTorrentFile,
  listTorrents,
  refreshTorrent
} from "../controllers/torrentsController.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

router.get("/", listTorrents);
router.get("/:id/refresh", refreshTorrent);
router.post("/magnet", addMagnet);
router.post("/upload", upload.single("torrent"), addTorrentFile);

export default router;
