import express from "express";
import session from "express-session";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import csrf from "csurf";
import torrentsRouter from "./routes/torrents.js";
import pollingService from "./services/pollingService.js";
import logger from "./utils/logger.js";
import { resolveSessionSecret } from "./utils/sessionSecret.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `TRUST_PROXY` controls how many reverse-proxy hops to trust.
// Default `1` matches "exactly one reverse proxy in front" — e.g. tinyauth.
// Set to `2` if a CDN sits in front of the auth proxy. Set to `0` or `false`
// if the app is exposed directly (NOT recommended).
const trustProxy = (() => {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return 1;
  if (raw === "false") return false;
  if (raw === "true") return true;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
})();
app.set("trust proxy", trustProxy);

// Sanitize the morgan URL token: replace magnet:?... query strings with "magnet:?<redacted>"
// so the full magnet link never lands in stdout / log aggregation.
const sanitizeUrl = (url) => {
  if (typeof url !== "string") return "";
  return url.replace(/magnet:\?[^"\s]*/gi, "magnet:?<redacted>");
};
morgan.token("sanitized-url", (req) => sanitizeUrl(`${req.method} ${req.originalUrl || req.url}`));
app.use(morgan(":remote-addr - :method :sanitized-url :status :response-time ms - :res[content-length]"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Attach Socket.IO instance to requests
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// Optional per-user session binding.
// When `AUTH_USER_HEADER` is set (e.g. `remote-user`), the value of that header
// becomes the user identity and per-user torrent lists are namespaced. When the
// header is absent on a request, the request is rejected with 401 / refused at
// the Socket.IO layer. When `AUTH_USER_HEADER` is empty (the default), the app
// behaves as before — anonymous session per browser, no per-user binding.
const authUserHeader = (process.env.AUTH_USER_HEADER || "").trim().toLowerCase();

const readAuthUser = (req) => {
  if (!authUserHeader) return null;
  const value = req.headers[authUserHeader];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
};

// Resolve the session secret before constructing the session middleware.
// This will throw on boot if the data directory cannot be created/written.
const { secret: sessionSecret, source: secretSource } = await resolveSessionSecret();
logger.info(`[SessionSecret] Using secret from: ${secretSource}`);

// Session configuration
const sessionStore = new session.MemoryStore();
const sessionMiddleware = session({
  name: "debrid_canal",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});

app.use(sessionMiddleware);

// Per-/api/* rate limiter. Applied to the optional AUTH_USER_HEADER block
// (the route CodeQL flagged for "missing rate limiting") and to the
// /api/torrents router below. Must run AFTER sessionMiddleware so the
// keyGenerator can read req.session.userId when AUTH_USER_HEADER is set.
app.use("/api", apiLimiter);

// Optional per-user binding middleware (runs after session so we can attach userId)
if (authUserHeader) {
  app.use((req, res, next) => {
    const userId = readAuthUser(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required." });
    }
    req.session.userId = userId;
    next();
  });
}

const csrfProtection = csrf();
app.get("/api/csrf-token", authLimiter, csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Track session activity
app.use((req, _res, next) => {
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  next();
});

app.use((req, _res, next) => {
  if (authUserHeader) {
    // Per-user namespacing when AUTH_USER_HEADER is set.
    if (!req.session.torrentsByUser) {
      req.session.torrentsByUser = {};
    }
    const userId = req.session.userId;
    if (userId && !req.session.torrentsByUser[userId]) {
      req.session.torrentsByUser[userId] = [];
    }
    // Expose a flat `torrents` view for the controllers.
    req.session.torrents = userId ? req.session.torrentsByUser[userId] : [];
  } else if (!req.session.torrents) {
    req.session.torrents = [];
  }
  next();
});

app.use("/api/torrents", csrfProtection, torrentsRouter);
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/ready", async (_req, res) => {
  const apiKey = process.env.REALDEBRID_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ status: "not-ready", reason: "REALDEBRID_API_KEY not set" });
  }
  res.json({ status: "ok" });
});

app.use((err, _req, res, next) => {
  if (err && err.code === "EBADCSRFTOKEN") {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }
  return next(err);
});

// Socket.IO configuration
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Per-user Socket.IO auth check (only when AUTH_USER_HEADER is set)
if (authUserHeader) {
  io.use((socket, next) => {
    const userId = readAuthUser(socket.request);
    if (!userId) {
      return next(new Error("Authentication required"));
    }
    next();
  });
}

io.on('connection', (socket) => {
  const session = socket.request.session;
  const sessionId = socket.request.sessionID;

  if (session && sessionId) {
    socket.sessionId = sessionId;
    socket.join(sessionId);
    logger.info(`[Socket.IO] Client connected: ${socket.id} (session: ${sessionId})`);
    logger.debug(`[Socket.IO] Socket joined room: ${sessionId}`);

    // Send initial torrent data — when AUTH_USER_HEADER is set, scope to that user.
    let torrents = session.torrents || [];
    if (authUserHeader && session.userId && session.torrentsByUser) {
      torrents = session.torrentsByUser[session.userId] || [];
    }
    socket.emit('torrents-updated', {
      torrents,
      allComplete: torrents.every(t => t.status === 'downloaded' && t.progress === 100)
    });
  }

  socket.on('disconnect', () => {
    logger.info(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Initialize polling service
pollingService.initialize(io, sessionStore);

// Session cleanup - runs every hour
setInterval(() => {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  sessionStore.all((err, sessions) => {
    if (err) {
      logger.error('[SessionCleanup] Error fetching sessions:', err);
      return;
    }

    if (!sessions) return;

    let cleanedCount = 0;
    for (const sessionId in sessions) {
      const session = sessions[sessionId];

      // Check if session is stale (no activity in 7 days)
      if (session.lastActivity && session.lastActivity < sevenDaysAgo) {
        sessionStore.destroy(sessionId, (err) => {
          if (err) {
            logger.error(`[SessionCleanup] Error destroying session ${sessionId}:`, err);
          } else {
            cleanedCount++;
          }
        });
      }
    }

    if (cleanedCount > 0) {
      logger.info(`[SessionCleanup] Cleaned up ${cleanedCount} stale session(s)`);
    }
  });
}, 60 * 60 * 1000); // Run every hour

httpServer.listen(port, () => {
  logger.info(`debrid-canal listening on port ${port}`);
});
