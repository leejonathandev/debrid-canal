# debrid-canal

A Node.js web interface for uploading torrent files or magnet links and retrieving Real-Debrid download links. Torrents belong to individual browser sessions; TinyAuth handles sign-in outside the application.

## Local setup

Requires Node.js 24 or newer and an active [Real-Debrid API key](https://real-debrid.com/apitoken).

```bash
git clone https://github.com/leejonathandev/debrid-canal.git
cd debrid-canal
npm ci
cp .env.example .env
# Edit .env to add your Real-Debrid API key.
npm start
```

Open [localhost:3000](http://localhost:3000). Development mode supports HTTP and creates a temporary random session secret when none is configured. Use this mode only on a trusted development machine.

## Production with TinyAuth and Traefik

The supported deployment uses Traefik for HTTPS and TinyAuth with OAuth for authentication. The application does not provide a second login system or trust user identity headers. Keep the backend accessible only to your trusted proxy network.

1. Set `REALDEBRID_API_KEY` in `.env` and generate `SESSION_SECRET` with `openssl rand -hex 32`. Production rejects missing, short, or known placeholder secrets. The same secret protects session cookies and CSRF tokens.
2. Attach the Compose service to your existing Traefik Docker network and configure your existing HTTPS router to send traffic to container port 3000. The included Compose file does **not** publish a host port. Do not add a publicly reachable port mapping.
3. Apply your TinyAuth forward-auth middleware to the whole application router, including `/api/*` and `/socket.io/*`. Protect both Engine.IO polling requests and WebSocket upgrades. Do not create an unprotected Socket.IO router.
4. Set `TRUST_PROXY` to the exact trusted proxy-hop count. A single Traefik hop uses `1`. Keep Traefik's forwarded-header trust restricted to your actual upstream proxies; browser-supplied forwarded headers must not be accepted as authoritative.
5. Build and start with `docker compose up -d --build`. The image runs as the unprivileged `node` user on Node.js 24.

For a prebuilt image, use `ghcr.io/leejonathandev/debrid-canal:latest` (the source repository's validated main pushes publish this image). Set `GITHUB_REPOSITORY_OWNER=leejonathandev` when using the included Compose file with that image, or substitute your own registry owner.

### Deployment checks

- An unauthenticated request to the public application, `/api/torrents`, and `/socket.io/?EIO=4&transport=polling` must be rejected or redirected by TinyAuth. Test WebSocket upgrades as well; they must not succeed anonymously.
- After OAuth sign-in, uploads, live progress updates, download links, and cancellation must work over HTTPS.
- The host must not expose the backend's port 3000. `/health` and `/ready` can be probed from inside the trusted container network without publishing the port.
- `/health` reports process liveness. `/ready` returns 503 when an API key is missing or still set to the documented placeholder; it does not call Real-Debrid or validate account status.

These are checks to run against your deployment; repository tests cannot verify your deployed Traefik or TinyAuth configuration.

### Sessions and restart behavior

The app intentionally uses a single-process in-memory session store. Restarting or replacing the container loses browser torrent lists and download metadata, even when the session secret is unchanged. Torrents and generated downloads can remain in your Real-Debrid account; use Real-Debrid's interface to manage those after a restart. A persistent secret does not persist session data. Multiple replicas and durable session storage are not supported in this version.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REALDEBRID_API_KEY` | none | Required to use Real-Debrid. |
| `SESSION_SECRET` | temporary random value in development | Production requires at least 32 characters and rejects known placeholders. Generate 32 random bytes or more. |
| `NODE_ENV` | development; production in Docker | Production enables Secure cookies and strict secret validation. |
| `PORT` | 3000 | HTTP listen port behind the proxy. |
| `TRUST_PROXY` | 1 | Trusted hop count, 0–10; `false` disables proxy trust. |
| `LOG_LEVEL` | info | trace, debug, info, warn, error, fatal. Request bodies and download URLs are not logged. |
| `RATE_LIMIT_API` | 300 | API requests per client IP per 15 minutes. |
| `RATE_LIMIT_CSRF` | 30 | Additional CSRF-token request limit per client IP per 15 minutes. |

All mutating torrent requests require a session-bound token in the `CSRF-Token` header, including the legacy `GET /api/torrents?refresh=1` option, which can generate upstream links. Obtain it from `GET /api/csrf-token`; tokens in query strings or request bodies are not accepted. Responses use JSON errors; size-limit violations return 413, CSRF failures return 403, and request limits return 429 with `Retry-After`.

The upload limit is 50 MB, with one `.torrent` file per request. Filename checks are an input filter; Real-Debrid validates torrent contents. Magnet links are limited to 8 KB.

Every Real-Debrid request shares a budget of 250 attempts per minute, four concurrent operations, and at most 64 queued operations. HTTP 429 pauses new upstream requests for at least 60 seconds and honors longer `Retry-After` values. Failed requests count toward the budget. Background polling retries transient failures and incomplete download links; terminal torrent errors stop polling. Cancellation waits for in-progress session updates and removes the upstream torrent and its known generated downloads. Cleanup failures leave the item available for retry rather than reporting successful removal.

## Validation

```bash
npm ci --ignore-scripts
npm test
npm audit --audit-level=low
```

Tests use mocked Real-Debrid responses and local HTTP/WebSocket servers; no real API key is needed. CI tests Node.js 24 and 26, audits all dependencies, and builds the container on PRs. Publishing to GHCR occurs only after tests and audits pass on `main`.

## License

MIT. This tool is for personal use. Respect Real-Debrid's terms and API limits.
