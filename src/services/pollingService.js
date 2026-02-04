/**
 * Polling Service
 * Server-side centralized polling for torrent updates
 * - Polls every 1 second when there are active downloads
 * - Stops polling when all torrents are downloaded
 * - Checks rate limit before making API calls
 * - Broadcasts updates to clients via Socket.IO
 */

import rateLimitMonitor from './rateLimitMonitor.js';
import * as realDebridService from './realdebrid.js';

class PollingService {
  constructor() {
    this.io = null;
    this.sessionStore = null;
    this.pollingInterval = null;
    this.isPolling = false;
    this.pollIntervalMs = 1000; // 1 second for active downloads
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
   * Main polling loop - runs every 1 second
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

      let accountTorrents = [];
      try {
        if (rateLimitMonitor.canMakeRequest()) {
          rateLimitMonitor.recordRequest();
          accountTorrents = await realDebridService.listTorrents({
            offset: 0,
            limit: 100
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

        // Check if this session has any active downloads
        const activeTorrents = session.torrents.filter(t => 
          t.status !== 'downloaded' || t.progress < 100
        );

        if (activeTorrents.length > 0) {
          hasActiveTorrents = true;
          // Refresh torrents for this session
          this.refreshSessionTorrents(sessionId, session, torrentMap);
        } else {
          // All torrents downloaded, send update to client
          const socketIds = this.getSocketIdsForSession(sessionId);
          socketIds.forEach(socketId => {
            this.io.to(socketId).emit('torrents-updated', {
              torrents: session.torrents,
              allComplete: true
            });
          });
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
      return;
    }

    const updatedTorrents = [];

    for (const torrent of session.torrents) {
      const listItem = torrentMap?.get(torrent.id);

      if (!listItem) {
        updatedTorrents.push(torrent);
        continue;
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

      updatedTorrents.push({
        ...torrent,
        name: listItem.name || torrent.name,
        status: listItem.status,
        progress: listItem.progress,
        unrestrictedLink
      });
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
    const socketIds = this.getSocketIdsForSession(sessionId);
    const allComplete = updatedTorrents.every(t => t.status === 'downloaded' && t.progress === 100);
    
    socketIds.forEach(socketId => {
      this.io.to(socketId).emit('torrents-updated', {
        torrents: updatedTorrents,
        allComplete
      });
    });
  }

  /**
   * Get all socket IDs associated with a session ID
   * @param {string} sessionId - Express session ID
   * @returns {Array<string>} Array of socket IDs
   */
  getSocketIdsForSession(sessionId) {
    const socketIds = [];
    
    if (!this.io || !this.io.sockets || !this.io.sockets.sockets) {
      return socketIds;
    }

    // Iterate through all connected sockets
    this.io.sockets.sockets.forEach((socket) => {
      if (socket.sessionId === sessionId) {
        socketIds.push(socket.id);
      }
    });

    return socketIds;
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
