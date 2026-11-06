# debrid-canal

A Node.js web interface for uploading torrent files or magnet links and retrieving Real-Debrid download links. Torrents belong to individual browser sessions; TinyAuth handles sign-in outside the application.

## Local setup

Requires Node.js 26.13.0 (LTS) or newer and an active [Real-Debrid API key](https://real-debrid.com/apitoken).

```bash
git clone https://github.com/leejonathandev/debrid-canal.git
cd debrid-canal
npm ci
cp .env.example .env
# Edit .env to add your Real-Debrid API key and a stable SESSION_SECRET.
npm start
```

Open [localhost:3000](http://localhost:3000). Development mode supports HTTP and creates a temporary random session secret when none is configured. Set a stable secret with `openssl rand -hex 32` to keep browser sessions usable across development restarts. Use this mode only on a trusted development machine.

## Production with TinyAuth and Traefik

The supported deployment uses Traefik for HTTPS and TinyAuth with OAuth for authentication. The application does not provide a second login system or trust user identity headers. Keep the backend accessible only to your trusted proxy network.

1. Set `REALDEBRID_API_KEY` in `.env` and generate `SESSION_SECRET` with `openssl rand -hex 32`. Production rejects missing, short, or known placeholder secrets. The same secret protects session cookies and CSRF tokens.
2. Attach the Compose service to your existing Traefik Docker network and configure your existing HTTPS router to send traffic to container port 3000. The included Compose file does **not** publish a host port. Do not add a publicly reachable port mapping.
3. Apply your TinyAuth forward-auth middleware to the whole application router, including `/api/*` and `/socket.io/*`. Protect both Engine.IO polling requests and WebSocket upgrades. Do not create an unprotected Socket.IO router.
4. Set `TRUST_PROXY` to the exact trusted proxy-hop count. A single Traefik hop uses `1`. Keep Traefik's forwarded-header trust restricted to your actual upstream proxies; browser-supplied forwarded headers must not be accepted as authoritative.
5. Build and start with `docker compose up -d --build`. The image runs as the unprivileged `node` user on Node.js 26 LTS. Keep the `session-data:/app/data` volume and your `SESSION_SECRET` across container replacements.

For a prebuilt image, use `ghcr.io/leejonathandev/debrid-canal:latest` (the source repository's validated main pushes publish this image). Set `GITHUB_REPOSITORY_OWNER=leejonathandev` when using the included Compose file with that image, or substitute your own registry owner.

### Deployment checks

- An unauthenticated request to the public application, `/api/torrents`, and `/socket.io/?EIO=4&transport=polling` must be rejected or redirected by TinyAuth. Test WebSocket upgrades as well; they must not succeed anonymously.
- After OAuth sign-in, uploads, live progress updates, download links, and cancellation must work over HTTPS.
- The host must not expose the backend's port 3000. `/health` and `/ready` can be probed from inside the trusted container network without publishing the port.
- `/health` reports process liveness. `/ready` returns 503 when an API key is missing or still set to the documented placeholder; it does not call Real-Debrid or validate account status.

These are checks to run against your deployment; repository tests cannot verify your deployed Traefik or TinyAuth configuration.

### Sessions and restart behavior

Sessions, browser torrent lists, progress, and generated download IDs are stored in `DATA_DIR/sessions.sqlite`. The default directory is `./data`; Compose uses a named volume at `/app/data`. Pending torrents and incomplete download links resume polling when the server starts, without waiting for a browser to connect. Completed torrents and cancellation metadata also survive restarts. The first upgrade from the old in-memory version cannot recover its previous lists; manage any untracked torrents in Real-Debrid's interface.

Keep both the data volume and the same `SESSION_SECRET`. Replacing the secret or clearing browser cookies prevents the browser from recovering its old list. Ownership remains per browser session, not per TinyAuth account. Sessions expire after seven days without an HTTP session touch; background polling does not extend their lifetime. Expired session rows are pruned at startup and at least hourly. Expiry does not delete torrents or downloads from Real-Debrid. The browser can bootstrap a fresh session and reconnect when its previous session expires.

Use one application instance and a local filesystem for the database. SQLite takes an exclusive lock; a second instance using the same file fails startup. Separate databases do not make multiple replicas safe. The database uses Node's built-in SQLite support, synchronous durable writes, and a rollback journal. No additional database service is needed.

The database contains private session IDs and download links. The app creates the database with owner-only permissions. For a bind mount, create a dedicated directory writable by container UID 1000 and restrict access to it. Do not store it inside `public/`, commit it, or include it in support uploads. The default data directory and SQLite files are excluded from Git and image builds.

To back up or restore, stop the service with `docker compose stop debrid-canal`, copy the **entire data volume** using your volume backup tooling, and restart with `docker compose start debrid-canal`. Keep the matching session secret separately in your secret backup. Restore into the same volume with UID 1000 ownership before starting the app. Do not copy only a live database file, discard a recovery journal, or run `docker compose down -v` unless you intend to erase session data. Test restores before relying on a backup.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REALDEBRID_API_KEY` | none | Required to use Real-Debrid. |
| `SESSION_SECRET` | temporary random value in development | Production requires at least 32 characters and rejects known placeholders. Generate 32 random bytes or more. |
| `DATA_DIR` | `./data`; `/app/data` in Compose | Dedicated writable directory for persistent sessions. Keep its volume and the session secret across restarts. |
| `NODE_ENV` | development; production in Docker | Production enables Secure cookies and strict secret validation. |
| `PORT` | 3000 | HTTP listen port behind the proxy. |
| `TRUST_PROXY` | 1 | Trusted hop count, 0–10; `false` disables proxy trust. |
| `LOG_LEVEL` | info | trace, debug, info, warn, error, fatal. Request bodies and download URLs are not logged. |
| `RATE_LIMIT_API` | 300 | API requests per client IP per 15 minutes. |
| `RATE_LIMIT_CSRF` | 30 | Additional CSRF-token request limit per client IP per 15 minutes. |

All mutating torrent requests require a session-bound token in the `CSRF-Token` header. Obtain it from `GET /api/csrf-token`; tokens in query strings or request bodies are not accepted. Bulk refresh now uses `POST /api/torrents/refresh`. `GET` and `HEAD /api/torrents` only read the saved list, even when the legacy `refresh` query parameter is present. Update any scripts that used the old GET refresh action.

`GET /api/torrents` retains its array response. `GET /api/torrents/state` and Socket.IO's `torrents-updated` event include `sessionKey`, `revision`, `torrents`, and `allComplete`; the CSRF bootstrap response also includes this snapshot as `state`. The public ordering key cannot authenticate a session. Clients ignore older snapshots and events from previous sessions. The browser renews a rejected CSRF token and retries the rejected action at most once; network and upstream failures do not automatically replay mutations. Responses use JSON errors; size-limit violations return 413, CSRF failures return 403 with code `EBADCSRFTOKEN`, and request limits return 429 with `Retry-After`.

The upload limit is 50 MB, with one `.torrent` file per request. Filename checks are an input filter; Real-Debrid validates torrent contents. Magnet links are limited to 8 KB.

Every Real-Debrid request shares a budget of 250 attempts per minute, four concurrent operations, and at most 64 queued operations. HTTP 429 pauses new upstream requests for at least 60 seconds and honors longer `Retry-After` values. Failed requests count toward the budget. Background polling retries transient failures and incomplete download links; terminal torrent errors stop polling. Cancellation waits for in-progress session updates and removes the upstream torrent and its known generated downloads. Cleanup failures leave the item available for retry rather than reporting successful removal.

## Validation

```bash
npm ci --ignore-scripts
npm test
npm audit --audit-level=low
```

Tests use mocked Real-Debrid responses, local HTTP/WebSocket servers, and temporary SQLite databases. They cover restart/resume, durable cancellation metadata, expiry, concurrent cookie touches, read-only HEAD/GET requests, browser update ordering, and session recovery. CI tests the latest Node.js 26 release, audits all dependencies, and builds the container on PRs. Publishing to GHCR occurs only after tests and audits pass on `main`.

## License

MIT. This tool is for personal use. Respect Real-Debrid's terms and API limits.
