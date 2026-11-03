import { Router } from "express";
import multer from "multer";
import { createTorrentsController } from "../controllers/torrentsController.js";

export function createTorrentsRouter(dependencies) {
  const router = Router();
  const controller = createTorrentsController(dependencies);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
    fileFilter: (_req, file, cb) => {
      if (!file.originalname.toLowerCase().endsWith(".torrent")) {
        return cb(Object.assign(new Error("Only .torrent files are accepted."), { status: 400 }));
      }
      cb(null, true);
    }
  });
  router.get("/", controller.listTorrents);
  router.get("/state", controller.getState);
  router.post("/refresh", controller.refreshTorrents);
  router.delete("/:id", controller.cancelTorrent);
  router.post("/:id/refresh", controller.refreshTorrent);
  router.post("/magnet", controller.addMagnet);
  router.post("/upload", upload.single("torrent"), controller.addTorrentFile);
  return router;
}
