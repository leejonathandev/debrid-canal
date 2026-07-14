/**
 * Rate limiters for sensitive routes.
 *
 * Two limiters are exported:
 *
 *   1. `apiLimiter` — broad, per-IP limit applied to /api/* and the optional
 *      AUTH_USER_HEADER middleware. This is the CodeQL "js/missing-rate-limiting"
 *      remediation: the route handler performs authorization, so it must be
 *      rate-limited. Applied before CSRF so a flood of CSRF-protected POSTs
 *      is also rate-limited.
 *
 *   2. `authLimiter` — tight, per-IP limit applied to /api/csrf-token only.
 *      Without this, an attacker could ask for an unlimited number of fresh
 *      CSRF tokens, each of which forces a server-side token computation.
 *
 * Defaults are intentionally conservative for a personal-use app:
 *   - 300 req / 15 min for /api/* (2 req/min sustained, but bursts allowed)
 *   - 30 req / 15 min for the CSRF token endpoint
 *
 * Both limits are tunable via env vars so operators behind a reverse proxy
 * with hundreds of users don't have to recompile.
 *
 * Trust proxy: we honor app.get("trust proxy") so the limiter sees the real
 * client IP. With TRUST_PROXY=1 (the default), the rightmost X-Forwarded-For
 * hop is trusted — correct for "one reverse proxy in front".
 */

import rateLimit from "express-rate-limit";
import logger from "../utils/logger.js";

const parsePositiveInt = (raw, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const API_LIMIT = parsePositiveInt(process.env.RATE_LIMIT_API, 300);
const AUTH_LIMIT = parsePositiveInt(process.env.RATE_LIMIT_CSRF, 30);

const message = (req) => ({
  error: "Too many requests, please try again later.",
  retryAfter: Math.ceil(WINDOW_MS / 1000)
});

/**
 * Limiter for /api/* (and the AUTH_USER_HEADER middleware, which is the
 * route CodeQL flagged for missing rate limiting).
 *
 * When AUTH_USER_HEADER is set, the per-user id is a much more useful
 * bucket than the IP — many users can share an outbound NAT (corporate,
 * school, mobile carrier), and a single user behind a VPN with a rotating
 * IP shouldn't be able to skirt the limit. Falls back to the IP-based
 * helper when no user id is present.
 */
export const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: API_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
  keyGenerator: (req, _res) => {
    if (req.session && typeof req.session.userId === "string" && req.session.userId.length > 0) {
      return `user:${req.session.userId}`;
    }
    // IPv6 hosts can rotate through enormous subnets; mask to /64 to stop a
    // single client from dodging the limit by IP-hopping.
    return `ip:${maskIpv6(req.ip)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn(`[RateLimit] /api/* limit hit for ${req.ip} (userId=${req.session?.userId || "<none>"})`);
    res.status(options.statusCode).json(options.message(req));
  }
});

/**
 * Tighter limiter for /api/csrf-token. CSRF tokens are session-bound and
 * cheap to serve, but a flood still wastes memory and CPU. Lower limit
 * and shared window so a malicious client can't rapidly rotate tokens.
 */
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: AUTH_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
  keyGenerator: (req, _res) => `ip:${maskIpv6(req.ip)}`,
  handler: (req, res, _next, options) => {
    logger.warn(`[RateLimit] /api/csrf-token limit hit for ${req.ip}`);
    res.status(options.statusCode).json(options.message(req));
  }
});

/**
 * Mask an IPv6 address to a /64. IPv4 is returned unchanged. This is the
 * subset of express-rate-limit's `ipKeyGenerator` we need, inlined so we
 * don't have to import a named export that is not present in v7.5.x's
 * ESM build.
 */
function maskIpv6(ip) {
  if (typeof ip !== "string" || ip.length === 0) return "ip:unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    // /64 keeps the first 4 groups; zero-pad short addresses.
    const head = parts.slice(0, 4);
    while (head.length < 4) head.push("0");
    return `ip:${head.join(":").toLowerCase()}::/64`;
  }
  return `ip:${ip}`;
}
