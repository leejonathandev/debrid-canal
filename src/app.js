import express from "express";
import cookieParser from "cookie-parser";
import session from "express-session";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { doubleCsrf } from "csrf-csrf";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { createTorrentsRouter } from "./routes/torrents.js";
import { createRealDebridService } from "./services/realdebrid.js";
import { PollingService } from "./services/pollingService.js";
import { RateLimitMonitor } from "./services/rateLimitMonitor.js";
import { SessionTorrents, callStore } from "./services/sessionTorrents.js";
import { SqliteSessionStore } from "./services/sqliteSessionStore.js";
import { resolveSessionSecret, positiveInteger, resolveTrustProxy } from "./config.js";
import logger from "./utils/logger.js";

export function createApplication({ env = process.env, service, monitor = new RateLimitMonitor(), sessionStore } = {}) {
  const secret = resolveSessionSecret(env);
  sessionStore ||= new SqliteSessionStore({ directory: env.DATA_DIR || "./data" });
  service ||= createRealDebridService({ apiKey: env.REALDEBRID_API_KEY, monitor });
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });
  const sessions = new SessionTorrents(sessionStore, io);
  const poller = new PollingService({ service, monitor });
  poller.initialize(io, sessionStore, sessions);
  // Resume stored work even when no browser is connected after a restart.
  httpServer.once("listening", () => { void poller.triggerImmediatePoll(); });
  app.disable("x-powered-by");
  app.set("trust proxy", resolveTrustProxy(env.TRUST_PROXY));
  // Paths are enough to diagnose requests; query strings may contain tokens.
  morgan.token("request-path", req => req.path);
  app.use(morgan(":remote-addr :method :request-path :status :response-time ms", { skip: () => env.NODE_ENV === "test" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", (_req, res) => {
    const ready = Boolean(env.REALDEBRID_API_KEY && env.REALDEBRID_API_KEY !== "your_api_key_here");
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "not-ready" });
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public")));

  const limiter = limit => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." }
  });
  app.use("/api", limiter(positiveInteger(env.RATE_LIMIT_API, 300)));
  app.use("/api/csrf-token", limiter(positiveInteger(env.RATE_LIMIT_CSRF, 30)));
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 20 }));
  app.use(cookieParser());
  const secure = env.NODE_ENV === "production";
  const sessionMiddleware = session({
    name: "debrid_canal", secret, resave: false, saveUninitialized: false, rolling: true,
    store: sessionStore,
    cookie: { httpOnly: true, sameSite: "lax", secure, maxAge: 7 * 24 * 60 * 60 * 1000 }
  });
  app.use("/api", sessionMiddleware);
  app.use("/api", async (req, _res, next) => {
    // Save initial identity before torrent writes. Existing snapshots remain
    // read-only, so Express's response-finalization cannot overwrite the queue.
    if (!req.session.createdAt) {
      req.session.createdAt = Date.now();
      // Public ordering key, independent of the private signed session cookie.
      req.session.stateKey = randomUUID();
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    }
    next();
  });
  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: req => req.sessionID,
    cookieName: "debrid_canal_csrf",
    cookieOptions: { httpOnly: true, sameSite: "lax", secure, path: "/" },
    getCsrfTokenFromRequest: req => req.headers["csrf-token"],
    errorConfig: { statusCode: 403, message: "Invalid CSRF token", code: "EBADCSRFTOKEN" }
  });
  app.get("/api/csrf-token", async (req, res) => res.json({
    csrfToken: generateCsrfToken(req, res), state: await sessions.snapshot(req.sessionID)
  }));
  app.use("/api/torrents", doubleCsrfProtection, createTorrentsRouter({ service, sessions, poller }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500;
    let message = status < 500 ? error.message : "The request could not be completed. Please try again.";
    if (error.code === "EBADCSRFTOKEN") { status = 403; message = "Invalid CSRF token"; }
    if (error instanceof multer.MulterError) {
      status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      message = error.code === "LIMIT_FILE_SIZE" ? "Torrent file exceeds the 50 MB limit." : "Invalid multipart upload.";
    }
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    // Avoid logging axios errors: they contain the API key and submitted data.
    if (status >= 500) logger.error(`[HTTP] Request failed (${status}).`);
    res.status(status).json({ error: message, ...(error.code === "EBADCSRFTOKEN" ? { code: error.code } : {}) });
  });

  // TinyAuth/Traefik must gate the complete /socket.io path, including upgrades.
  io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    try {
      const stored = await callStore(sessionStore, "get", socket.request.sessionID);
      if (!stored?.createdAt) {
        return next(Object.assign(new Error("Session required. Please reconnect."), { data: { code: "SESSION_REQUIRED" } }));
      }
      next();
    } catch { next(new Error("Session unavailable.")); }
  });
  io.on("connection", async socket => {
    try {
      const id = socket.request.sessionID;
      // Join before reading so commits during the read reach the client. The
      // client compares revisions if a live update arrives before the snapshot.
      await socket.join(id);
      socket.emit("torrents-updated", await sessions.snapshot(id));
    } catch { socket.disconnect(true); }
  });
  // Prune idle sessions even when polling has stopped, without extending expiry.
  const cleanup = setInterval(() => {
    sessionStore.all(error => { if (error) logger.error("Session cleanup failed."); });
  }, 60 * 60 * 1000);
  cleanup.unref();
  let closing;
  const close = () => closing ||= (async () => {
    clearInterval(cleanup);
    poller.shutdown();
    // Stop accepting requests, then drain requests and torrent writes before
    // closing SQLite. A finishing upload must not restart the poller.
    await new Promise(resolve => io.close(resolve));
    await poller.inFlight;
    await Promise.allSettled([...sessions.locks.values()]);
    if (sessionStore.close) await callStore(sessionStore, "close");
  })();
  return { app, httpServer, io, sessions, sessionStore, poller, monitor, close };
}
