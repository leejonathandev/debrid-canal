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
import logger from '../utils/logger.js';

dotenv.config();
const isDebug = logger.isDebug();

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
    logger.info('[PollingService] Initialized');
  }

  /**
   * Start polling if not already running
   */
  start() {
    if (this.isPolling) {
      return;
    }

    logger.info('[PollingService] Starting polling...');
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

    logger.info('[PollingService] Stopping polling...');
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
      logger.warn('[PollingService] Poll skipped: missing io or sessionStore');
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
        logger.error('[PollingService] Error fetching sessions:', err);
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
          logger.info('[PollingService] Rate limit reached, skipping listTorrents');
        }
      } catch (error) {
        logger.error('[PollingService] Error listing torrents:', error.message);
      }

      const torrentMap = new Map(accountTorrents.map((item) => [item.id, item]));

      // Process each session - log once per minute
      const now = Date.now();
      if (now - this.lastSessionLogAt >= 60 * 1000) {
        logger.info(`[PollingService] Polling ${sessionIds.length} session(s)`);
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
        logger.info('[PollingService] No active torrents, stopping polling');
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
        logger.error('[PollingService] Error saving session:', err);
      }
    });

    // Broadcast update to all sockets associated with this session
    const allComplete = updatedTorrents.every(t => t.status === 'downloaded' && t.progress === 100);
    logger.info(`[PollingService] Emitting 'torrents-updated' to session: ${sessionId}`);
    logger.info(`[PollingService] Number of torrents: ${updatedTorrents.length}`);
    logger.info('[PollingService] Torrent summary:', updatedTorrents.map(t => ({
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
      logger.info(`[PollingService] Torrent ${torrent.id} needs file selection, triggering selectFiles`);
      if (!rateLimitMonitor.canMakeRequest()) {
        logger.info('[PollingService] Rate limit reached, skipping selectFiles');
      } else {
        try {
          rateLimitMonitor.recordRequest();
          if (rateLimitMonitor.canMakeRequest()) {
            rateLimitMonitor.recordRequest();
            await realDebridService.selectAllFiles(torrent.id);
            logger.info(`[PollingService] Successfully selected files for torrent ${torrent.id}`);
          }
        } catch (error) {
          logger.error(`[PollingService] Error selecting files for ${torrent.id}:`, error.message);
        }
      }
    }

    let unrestrictedLink = torrent.unrestrictedLink || null;
    if (!unrestrictedLink && listItem.status === 'downloaded' && listItem.links.length) {
      if (!rateLimitMonitor.canMakeRequest()) {
        logger.info('[PollingService] Rate limit reached, skipping unrestrict');
      } else {
        try {
          rateLimitMonitor.recordRequest();
          unrestrictedLink = await realDebridService.getUnrestrictedLink(listItem.links[0]);
        } catch (error) {
          logger.error(`[PollingService] Error unrestricting link for ${torrent.id}:`, error.message);
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
    
    if (isDebug && torrent.progress !== listItem.progress) {
      logger.debug(`[PollingService DEBUG] Progress updated for ${torrent.id}: ${torrent.progress} -> ${listItem.progress}`);
    }
    
    updatedTorrents.push(updated);
  }

  /**
   * Force an immediate poll (called when new torrents are added)
   */
  triggerImmediatePoll() {
    logger.info('[PollingService] Immediate poll triggered');
    
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
