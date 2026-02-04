import express from "express";
import session from "express-session";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import torrentsRouter from "./routes/torrents.js";
import pollingService from "./services/pollingService.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);

// Custom Morgan format with IP address for client requests
app.use(morgan(':remote-addr - :method :url :status :response-time ms - :res[content-length]'));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Attach Socket.IO instance to requests
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// Session configuration
const sessionStore = new session.MemoryStore();
const sessionMiddleware = session({
  name: "debrid_canal",
  secret: process.env.SESSION_SECRET || "debrid-canal-secret",
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

// Track session activity
app.use((req, _res, next) => {
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  next();
});

app.use((req, _res, next) => {
  if (!req.session.torrents) {
    req.session.torrents = [];
  }
  next();
});

app.use("/api/torrents", torrentsRouter);
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Socket.IO configuration
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on('connection', (socket) => {
  const session = socket.request.session;
  
  if (session && session.id) {
    socket.sessionId = session.id;
    console.log(`[Socket.IO] Client connected: ${socket.id} (session: ${session.id})`);
    
    // Send initial torrent data
    socket.emit('torrents-updated', {
      torrents: session.torrents || [],
      allComplete: (session.torrents || []).every(t => t.status === 'downloaded' && t.progress === 100)
    });
  }

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Initialize polling service
pollingService.initialize(io, sessionStore);

// Session cleanup - runs every hour
setInterval(() => {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  sessionStore.all((err, sessions) => {
    if (err) {
      console.error('[SessionCleanup] Error fetching sessions:', err);
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
            console.error(`[SessionCleanup] Error destroying session ${sessionId}:`, err);
          } else {
            cleanedCount++;
          }
        });
      }
    }

    if (cleanedCount > 0) {
      console.log(`[SessionCleanup] Cleaned up ${cleanedCount} stale session(s)`);
    }
  });
}, 60 * 60 * 1000); // Run every hour

httpServer.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`debrid-canal listening on port ${port}`);
});
