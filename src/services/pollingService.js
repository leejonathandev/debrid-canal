/**
 * Polling Service
 * Server-side centralized polling for torrent updates
 * - Polls every 5 seconds when there are active downloads
 * - Stops polling when all torrents are downloaded
 * - Checks rate limit before making API calls
 * - Broadcasts updates to clients via Socket.IO
 */

import rateLimitMonitor from './rateLimitMonitor.js';
import * as realDebridService from './realdebrid.js';
import dotenv from 'dotenv';

dotenv.config();
const DEBUG = process.env.LOG_LEVEL === 'debug';

class PollingService {
  constructor() {
    this.io = null;
    this.sessionStore = null;
    this.pollingInterval = null;
    this.isPolling = false;
    this.pollIntervalMs = 5000; // 5 seconds for active downloads
    this.lastSessionLogAt = 0; // For throttling session count logs
  }

  /**
   * Initialize the polling service with Socket.IO instance and session store
   * @param {SocketIO.Server} io - Socket.IO server instance
   * @param {SessionStore} sessionStore - Express session store
   */
  initialize(io, sessionStore) {
    this.io = io;
    this.sessionStore = sessionStore;
    console.log('[PollingService] Initialized');
  }

  /**
   * Start polling if not already running
   */
  start() {
    if (this.isPolling) {
      return;
    }

    console.log('[PollingService] Starting polling...');
    this.isPolling = true;
    this.pollingInterval = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.isPolling) {
      return;
    }

    console.log('[PollingService] Stopping polling...');
    this.isPolling = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Main polling loop - runs every 5 seconds
   */
  async poll() {
    if (!this.io || !this.sessionStore) {
      console.warn('[PollingService] Poll skipped: missing io or sessionStore');
      return;
    }

    // Check rate limit before proceeding
    if (rateLimitMonitor.isRateLimited()) {
      const timeRemaining = rateLimitMonitor.getTimeUntilReset();
      // Broadcast rate limit status to all clients
      this.io.emit('rate-limit-hit', { 
        timeRemaining: Math.ceil(timeRemaining / 1000) 
      });
      return;
    }

    // Get all active sessions
    this.sessionStore.all(async (err, sessions) => {
      if (err) {
        console.error('[PollingService] Error fetching sessions:', err);
        return;
      }

      const sessionIds = sessions ? Object.keys(sessions) : [];
      if (sessionIds.length === 0) {
        // No active sessions, stop polling
        this.stop();
        return;
      }

      let hasActiveTorrents = false;

      const listLimit = Math.max(10, sessionIds.length * 10);

      let accountTorrents = [];
      try {
        if (rateLimitMonitor.canMakeRequest()) {
          rateLimitMonitor.recordRequest();
          accountTorrents = await realDebridService.listTorrents({
            limit: listLimit
          });
        } else {
          console.log('[PollingService] Rate limit reached, skipping listTorrents');
        }
      } catch (error) {
        console.error('[PollingService] Error listing torrents:', error.message);
      }

      const torrentMap = new Map(accountTorrents.map((item) => [item.id, item]));

      // Process each session - log once per minute
      const now = Date.now();
      if (now - this.lastSessionLogAt >= 60 * 1000) {
        console.log(`[PollingService] Polling ${sessionIds.length} session(s)`);
        this.lastSessionLogAt = now;
      }

      for (const sessionId in sessions) {
        const session = sessions[sessionId];
        
        if (!session.torrents || session.torrents.length === 0) {
          continue;
        }

        // Always refresh torrents for this session to avoid stale data
        const updatedTorrents = await this.refreshSessionTorrents(sessionId, session, torrentMap);
        if (updatedTorrents && updatedTorrents.some(t => t.status === 'downloading')) {
          hasActiveTorrents = true;
        }
      }

      // If no active torrents across all sessions, stop polling
      if (!hasActiveTorrents) {
        console.log('[PollingService] No active torrents, stopping polling');
        this.stop();
      }
    });
  }

  /**
   * Refresh torrents for a specific session
   * @param {string} sessionId - Session ID
   * @param {object} session - Session object
   */
  async refreshSessionTorrents(sessionId, session, torrentMap) {
    if (!session.torrents || session.torrents.length === 0) {
      return [];
    }

    const updatedTorrents = [];

    for (const torrent of session.torrents) {
      const listItem = torrentMap?.get(torrent.id);

      if (!listItem) {
        updatedTorrents.push(torrent);
        continue;
      }

      // Process torrent with list item data
      await this.processTorrentUpdate(torrent, listItem, updatedTorrents);
    }

    // Update session with new torrent data
    session.torrents = updatedTorrents;
    
    // Save session
    this.sessionStore.set(sessionId, session, (err) => {
      if (err) {
        console.error('[PollingService] Error saving session:', err);
      }
    });

    // Broadcast update to all sockets associated with this session
    const allComplete = updatedTorrents.every(t => t.status === 'downloaded' && t.progress === 100);
    console.log(`[PollingService] Emitting 'torrents-updated' to session: ${sessionId}`);
    console.log(`[PollingService] Number of torrents: ${updatedTorrents.length}`);
    console.log('[PollingService] Torrent summary:', updatedTorrents.map(t => ({
      id: t.id,
      progress: t.progress,
      status: t.status
    })));
    this.io.to(sessionId).emit('torrents-updated', {
      torrents: updatedTorrents,
      allComplete
    });

    return updatedTorrents;
  }

  /**
   * Process a single torrent update with list item data
   * @param {object} torrent - Current torrent data from session
   * @param {object} listItem - Fresh data from API
   * @param {Array} updatedTorrents - Array to push updated torrent to
   */
  async processTorrentUpdate(torrent, listItem, updatedTorrents) {
    // Check if torrent transitioned to waiting_files_selection
    if (listItem.status === 'waiting_files_selection' && torrent.status !== 'waiting_files_selection') {
      console.log(`[PollingService] Torrent ${torrent.id} needs file selection, triggering selectFiles`);
      if (!rateLimitMonitor.canMakeRequest()) {
        console.log('[PollingService] Rate limit reached, skipping selectFiles');
      } else {
        try {
          rateLimitMonitor.recordRequest();
          if (rateLimitMonitor.canMakeRequest()) {
            rateLimitMonitor.recordRequest();
            await realDebridService.selectAllFiles(torrent.id);
            console.log(`[PollingService] Successfully selected files for torrent ${torrent.id}`);
          }
        } catch (error) {
          console.error(`[PollingService] Error selecting files for ${torrent.id}:`, error.message);
        }
      }
    }

    let unrestrictedLink = torrent.unrestrictedLink || null;
    if (!unrestrictedLink && listItem.status === 'downloaded' && listItem.links.length) {
      if (!rateLimitMonitor.canMakeRequest()) {
        console.log('[PollingService] Rate limit reached, skipping unrestrict');
      } else {
        try {
          rateLimitMonitor.recordRequest();
          unrestrictedLink = await realDebridService.getUnrestrictedLink(listItem.links[0]);
        } catch (error) {
          console.error(`[PollingService] Error unrestricting link for ${torrent.id}:`, error.message);
        }
      }
    }

    const updated = {
      ...torrent,
      name: listItem.name || torrent.name,
      status: listItem.status,
      progress: listItem.progress,
      unrestrictedLink
    };
    
    if (DEBUG && torrent.progress !== listItem.progress) {
      console.log(`[PollingService DEBUG] Progress updated for ${torrent.id}: ${torrent.progress} -> ${listItem.progress}`);
    }
    
    updatedTorrents.push(updated);
  }

  /**
   * Force an immediate poll (called when new torrents are added)
   */
  triggerImmediatePoll() {
    console.log('[PollingService] Immediate poll triggered');
    
    // Start polling if not already running
    if (!this.isPolling) {
      this.start();
    }
    
    // Execute poll immediately
    this.poll();
  }
}

// Export singleton instance
export default new PollingService();
