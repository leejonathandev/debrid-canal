import { needsPolling } from "./torrentState.js";

export const callStore = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

// The only writer of torrent state. Express requests must not mutate their
// session snapshots: resave:false + MemoryStore.touch preserve these updates.
export class SessionTorrents {
  constructor(store, io) {
    this.store = store;
    this.io = io;
    this.locks = new Map();
  }

  async locked(id, action) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  async read(id) {
    return this.locked(id, async () => (await callStore(this.store, "get", id))?.torrents || []);
  }

  async mutate(id, action) {
    return this.locked(id, async () => {
      const session = await callStore(this.store, "get", id);
      if (!session) throw Object.assign(new Error("Session expired. Reload the page."), { status: 410 });
      const torrents = await action(session.torrents || []);
      // Preserve cookie touches during upstream I/O; never resurrect an expiry.
      const latest = await callStore(this.store, "get", id);
      if (!latest) throw Object.assign(new Error("Session expired. Reload the page."), { status: 410 });
      latest.torrents = torrents;
      await callStore(this.store, "set", id, latest);
      this.io?.to(id).emit("torrents-updated", {
        torrents,
        allComplete: torrents.length > 0 && torrents.every(t => t.status === "downloaded" && !needsPolling(t))
      });
      return torrents;
    });
  }
}
