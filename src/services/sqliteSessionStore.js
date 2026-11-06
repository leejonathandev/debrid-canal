import session from "express-session";
import { Database } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import path from "node:path";

// A single app process owns this database. Cookie touches update only the cookie,
// so finishing an older HTTP request cannot overwrite newer torrent state.
export class SqliteSessionStore extends session.Store {
  constructor({ directory = "./data", now = Date.now } = {}) {
    super();
    this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "sessions.sqlite");
    closeSync(openSync(filename, "a", 0o600));
    chmodSync(filename, 0o600);
    this.db = new Database(filename, { timeout: 5000 });
    try {
      // Exclusive locking enforces the application's single-instance contract.
      // DELETE journaling keeps stopped-volume backups straightforward.
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported session database version.");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL CHECK(json_valid(data)),
          expires INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
        PRAGMA user_version=1;
      `);
      this.statements = {
        get: this.db.prepare("SELECT data FROM sessions WHERE id = ? AND expires > ?"),
        set: this.db.prepare(`INSERT INTO sessions(id, data, expires) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data, expires=excluded.expires`),
        touch: this.db.prepare(`UPDATE sessions SET data=json_set(data, '$.cookie', json(?)), expires=?
          WHERE id=? AND expires > ?`),
        destroy: this.db.prepare("DELETE FROM sessions WHERE id=?"),
        prune: this.db.prepare("DELETE FROM sessions WHERE expires <= ?"),
        all: this.db.prepare("SELECT id, data FROM sessions")
      };
      this.statements.prune.run(this.now());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  expires(value) {
    const expiry = new Date(value.cookie?.expires).getTime();
    if (!Number.isFinite(expiry)) throw new Error("A session expiry is required.");
    return expiry;
  }

  complete(callback, action) {
    let result;
    try { result = action(); }
    catch (error) { queueMicrotask(() => callback?.(error)); return; }
    queueMicrotask(() => callback?.(null, result));
  }

  get(id, callback) {
    this.complete(callback, () => {
      const row = this.statements.get.get(id, this.now());
      return row ? JSON.parse(row.data) : null;
    });
  }

  set(id, value, callback) {
    this.complete(callback, () => {
      this.statements.set.run(id, JSON.stringify(value), this.expires(value));
    });
  }

  touch(id, value, callback) {
    this.complete(callback, () => {
      this.statements.touch.run(JSON.stringify(value.cookie), this.expires(value), id, this.now());
    });
  }

  destroy(id, callback) {
    this.complete(callback, () => { this.statements.destroy.run(id); });
  }

  all(callback) {
    this.complete(callback, () => {
      this.statements.prune.run(this.now());
      return Object.fromEntries(this.statements.all.all().map(row => [row.id, JSON.parse(row.data)]));
    });
  }

  close(callback) {
    this.complete(callback, () => { if (this.db.isOpen) this.db.close(); });
  }
}
