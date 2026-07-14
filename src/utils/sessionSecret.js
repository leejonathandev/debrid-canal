/**
 * Session secret resolution.
 *
 * Precedence on boot:
 *   1. process.env.SESSION_SECRET (power-user override; empty string treated as unset)
 *   2. Existing file at <DATA_DIR>/.session-secret (persisted across restarts)
 *   3. Generate a fresh 64-byte random secret, write atomically with mode 0600
 *
 * The secret is never logged. Only the *path* of a freshly generated file
 * is logged so the operator can back it up if they want.
 *
 * If the data directory cannot be created or written, this throws on boot.
 * Silent per-run secrets cause silent data loss on restart (every user is
 * logged out, every in-progress download is forgotten). Failure is the
 * correct behavior.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, readFile, stat } from "node:fs/promises";
import path from "node:path";
import logger from "./logger.js";

const SECRET_BYTES = 64;
const SECRET_FILE_NAME = ".session-secret";

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const secretFilePath = path.join(dataDir, SECRET_FILE_NAME);

const readEnvSecret = () => {
  const value = process.env.SESSION_SECRET;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
};

const readPersistedSecret = async () => {
  try {
    const content = await readFile(secretFilePath, "utf8");
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      // Surface unexpected errors (permission, I/O) but a missing file is normal
      // on first boot and is handled by the caller.
      throw error;
    }
  }
  return null;
};

const generateSecret = async () => {
  await mkdir(dataDir, { recursive: true });

  // Refuse to overwrite an existing file we couldn't read for some other reason.
  let existingStats = null;
  try {
    existingStats = await stat(secretFilePath);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  if (existingStats && existingStats.isFile()) {
    // File appeared between readFile() and now (race) — re-read it.
    const content = await readPersistedSecret();
    if (content) {
      return { secret: content, generated: false };
    }
  }

  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const tempPath = `${secretFilePath}.${process.pid}.tmp`;

  await writeFile(tempPath, `${secret}\n`, { mode: 0o600 });
  await rename(tempPath, secretFilePath);

  // Tighten permissions in case the filesystem preserved a broader umask.
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(secretFilePath, 0o600);
  } catch {
    // Best-effort; some filesystems (e.g. FAT) don't support chmod.
  }

  return { secret, generated: true, path: secretFilePath };
};

export const resolveSessionSecret = async () => {
  const envSecret = readEnvSecret();
  if (envSecret) {
    return { secret: envSecret, source: "env" };
  }

  const persisted = await readPersistedSecret();
  if (persisted) {
    return { secret: persisted, source: "file" };
  }

  const generated = await generateSecret();
  if (generated.generated) {
    logger.info(`[SessionSecret] Generated new session secret at ${generated.path}`);
    return { secret: generated.secret, source: "generated" };
  }

  return { secret: generated.secret, source: "file" };
};

export const getSecretFilePath = () => secretFilePath;
export const getDataDir = () => dataDir;
