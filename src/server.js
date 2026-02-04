import express from "express";
import session from "express-session";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import torrentsRouter from "./routes/torrents.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);

app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: "debrid_canal",
    secret: process.env.SESSION_SECRET || "debrid-canal-secret",
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`debrid-canal listening on port ${port}`);
});
