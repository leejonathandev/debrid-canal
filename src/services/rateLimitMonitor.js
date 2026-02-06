/**
 * Rate Limit Monitor Service
 * Tracks API requests to Real-Debrid and enforces rate limits
 * - Limits: 250 requests per minute
 * - On HTTP 429: blocks requests for 60 seconds
 */

import logger from '../utils/logger.js';

class RateLimitMonitor {
  constructor() {
    this.requestsPerMinute = [];
    this.rateLimitHit = false;
    this.rateLimitUntil = null;
    this.maxRequestsPerMinute = 250;
    this.rateLimitCooldownMs = 60000; // 60 seconds
  }

  /**
   * Check if we can make an API request
   * @returns {boolean} true if request is allowed, false otherwise
   */
  canMakeRequest() {
    // If rate limit was hit, check if cooldown period has elapsed
    if (this.rateLimitHit) {
      const now = Date.now();
      if (now < this.rateLimitUntil) {
        return false;
      }
      // Cooldown period has elapsed, reset rate limit flag
      this.rateLimitHit = false;
      this.rateLimitUntil = null;
      logger.info('[RateLimitMonitor] Rate limit cooldown complete, resuming API requests');
    }

    // Clean up old requests (older than 1 minute)
    const oneMinuteAgo = Date.now() - 60000;
    this.requestsPerMinute = this.requestsPerMinute.filter(timestamp => timestamp > oneMinuteAgo);

    // Check if we're under the limit
    return this.requestsPerMinute.length < this.maxRequestsPerMinute;
  }

  /**
   * Record a successful API request
   */
  recordRequest() {
    this.requestsPerMinute.push(Date.now());
  }

  /**
   * Mark that HTTP 429 rate limit error was encountered
   * Blocks all requests for 60 seconds
   */
  markRateLimitHit() {
    this.rateLimitHit = true;
    this.rateLimitUntil = Date.now() + this.rateLimitCooldownMs;
    logger.warn(`[RateLimitMonitor] HTTP 429 detected - blocking requests until ${new Date(this.rateLimitUntil).toISOString()}`);
  }

  /**
   * Get time remaining until rate limit cooldown ends
   * @returns {number} milliseconds remaining, or 0 if not rate limited
   */
  getTimeUntilReset() {
    if (!this.rateLimitHit || !this.rateLimitUntil) {
      return 0;
    }
    const remaining = this.rateLimitUntil - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Check if currently rate limited
   * @returns {boolean}
   */
  isRateLimited() {
    return this.rateLimitHit && this.getTimeUntilReset() > 0;
  }

  /**
   * Get current request count in the last minute
   * @returns {number}
   */
  getCurrentRequestCount() {
    const oneMinuteAgo = Date.now() - 60000;
    this.requestsPerMinute = this.requestsPerMinute.filter(timestamp => timestamp > oneMinuteAgo);
    return this.requestsPerMinute.length;
  }
}

// Export singleton instance
export default new RateLimitMonitor();
