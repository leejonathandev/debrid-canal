# debrid-canal
A Node.js web server that provides a simple interface for uploading torrent files or magnet links and retrieving download links via RealDebrid's API.

## Setup
### Requirements
- Node.js (LTS version recommended)
- RealDebrid account with an active [API key](https://real-debrid.com/apitoken) 
- Docker (optional, for containerized deployment)

### Node
```bash
git clone https://github.com/yourusername/debrid-canal.git
npm install
cp .env.example .env # add in your API key
npm start
```

### Docker Image
```bash
docker pull ghcr.io/<owner>/debrid-canal:latest
docker run -d \
  -p 3000:3000 \
  -e REALDEBRID_API_KEY=your_api_key_here \
  -e SESSION_SECRET=change_me \
  --name debrid-canal \
  ghcr.io/<owner>/debrid-canal:latest
```

### Environment Variables
| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `REALDEBRID_API_KEY` | Your RealDebrid API key | Yes | - |
| `PORT` | Port for the web server | No | 3000 |
| `NODE_ENV` | Environment mode | No | production |
| `LOG_LEVEL` | Logging level (trace, debug, info, warn, error, fatal) | No | info |

See [`.env.example`](.env.example) for the full list, including session secret, data dir, auth proxy header, and `TRUST_PROXY`.

## Deployment

The app is intended to run **behind a reverse proxy** — do not expose port 3000 directly to the internet. Put something like tinyauth, oauth2-proxy, Authelia, Authentik, Traefik forward-auth, Caddy, or Nginx in front of it for TLS termination and (optionally) authentication.

### Session secret

`SESSION_SECRET` is **auto-generated on first start** — you don't need to set it. The app writes a 64-byte random secret (hex-encoded, mode `0600`) to `<DATA_DIR>/.session-secret` and reuses it on every subsequent start. The secret is **never logged**. If you want to control the value yourself (e.g. for replication across multiple instances), set `SESSION_SECRET` explicitly; otherwise leave it blank.

To preserve the secret across image upgrades and container restarts, **mount the `./data` directory** to a host volume. For example in `docker-compose.yml`:

```yaml
volumes:
  - ./data:/app/data
```

### Forward-auth proxy (`AUTH_USER_HEADER`)

By default, the app runs in **anonymous mode** — each browser gets its own session and torrent list, with no notion of "user". This is the right mode if you have no auth proxy in front, or you don't care about per-user isolation.

If you run a forward-auth proxy in front of the app, set `AUTH_USER_HEADER` to the name of the header the proxy uses to identify the logged-in user. The default header name for most of these proxies is `Remote-User`, so the common configuration is:

```env
AUTH_USER_HEADER=remote-user
```

Supported proxies (and the header they send by default):

- tinyauth — `Remote-User`
- oauth2-proxy — `X-Forwarded-User` (or `Remote-User` depending on config)
- Authelia — `Remote-User`
- Authentik — `Remote-User`
- Traefik forward-auth — `Remote-User`
- Caddy (with `forward_auth`) — `Remote-User`
- Nginx (with `auth_request`) — `Remote-User` (set by `auth_request_set`)

When `AUTH_USER_HEADER` is set, the app namespaces per-user torrent lists by the header's value, so multiple authenticated users on the same instance don't see each other's downloads. Requests to `/api/*` (and Socket.IO) **without** the configured header are rejected with `401`. Leaving `AUTH_USER_HEADER` blank disables the feature and falls back to the anonymous-per-browser behavior.

### `TRUST_PROXY`

The app trusts `X-Forwarded-*` headers based on `TRUST_PROXY` (default `1`). `1` matches "exactly one reverse proxy in front" — the common case (e.g. tinyauth directly). Set it to `2` if you have a CDN (Cloudflare, Fastly, etc.) in front of your auth proxy. Do not set it to `true` — that lets clients spoof `X-Forwarded-For` and bypass the trusted-hop count.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer
This tool is for personal use only. Please respect RealDebrid's terms of service and API usage limits. The developers are not responsible for any misuse of this software.
