import { createRealDebridService } from "./realdebrid.js";
import rateLimitMonitor from "./rateLimitMonitor.js";
import { callStore } from "./sessionTorrents.js";
import { needsPolling } from "./torrentState.js";
import logger from "../utils/logger.js";

export class PollingService {
  constructor({ service, monitor = rateLimitMonitor, intervalMs = 5000 } = {}) {
    this.service = service || createRealDebridService({ monitor });
    this.monitor = monitor;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.inFlight = null;
    this.isPolling = false;
    this.generation = 0;
    this.closed = false;
  }

  initialize(io, sessionStore, sessions) {
    this.io = io;
    this.sessionStore = sessionStore;
    this.sessions = sessions;
  }

  start() {
    if (this.closed || this.isPolling) return;
    this.isPolling = true;
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.isPolling = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  triggerImmediatePoll() {
    if (this.closed) return Promise.resolve();
    this.generation++;
    this.start();
    return this.poll();
  }

  poll() {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCycle().catch(error => {
      logger.error("[PollingService] Poll failed:", error.message);
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  shutdown() {
    this.closed = true;
    this.stop();
  }

  async runCycle() {
    if (!this.sessions) return;
    const generation = this.generation;
    if (this.monitor.isRateLimited()) {
      this.io.emit("rate-limit-hit", { timeRemaining: Math.ceil(this.monitor.getTimeUntilReset() / 1000) });
      return;
    }
    const all = await callStore(this.sessionStore, "all");
    const ids = Object.keys(all || {}).filter(id => all[id].torrents?.some(needsPolling));
    if (!ids.length) {
      if (generation === this.generation) this.stop();
      return;
    }
    // A failed listing is not evidence that a tracked torrent disappeared.
    let listed = [];
    try {
      listed = await this.service.listTorrents({ limit: Math.min(5000, Math.max(10, ids.length * 10)) });
    } catch (error) {
      logger.warn("[PollingService] Account listing failed:", error.message);
    }
    const map = new Map(listed.map(t => [t.id, t]));
    let active = false;
    for (const id of ids) {
      try {
        const torrents = await this.sessions.mutate(id, async current => {
          const updated = [];
          for (const torrent of current) {
            if (!needsPolling(torrent)) { updated.push(torrent); continue; }
            try {
              // Falls back to /info for items outside the account listing.
              updated.push(await this.service.refreshTorrentInfo(torrent, map.get(torrent.id)));
            } catch (error) {
              if (error.response?.status === 404) {
                updated.push({ ...torrent, status: "dead", error: "Torrent no longer exists on Real-Debrid." });
              } else {
                updated.push({ ...torrent, error: "Update failed; retrying." });
                logger.warn("[PollingService] Torrent update failed:", error.message);
              }
            }
          }
          return updated;
        });
        active ||= torrents.some(needsPolling);
      } catch (error) {
        if (error.status !== 410) {
          active = true;
          logger.error("[PollingService] Session update failed:", error.message);
        }
      }
    }
    if (!active && generation === this.generation) this.stop();
  }
}
