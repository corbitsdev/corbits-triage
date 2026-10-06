# Deploy

Two services:

| Service | Image | State |
| --- | --- | --- |
| Postgres | any managed or self-run Postgres | `DATABASE_URL` |
| Hub | `docs/Dockerfile`: Interchange hub, webhooks, GitHub bridge, sidecars, and the built portal | volume at `HUB_DATA_DIR` |

The hub serves the portal itself (`PORTAL_DIR`, set by the image), so one public domain covers the portal, the API and GitHub webhooks (`/api/hooks/...`).

## Single server (v1)

The hub runs sidecars as local child processes, one per live deployment, on its own machine. This is the cheapest setup and the one supported today.

1. Provision Postgres. Add `?sslmode=require` to its URL when reached over the public internet.
2. Generate four secrets, one per variable: `openssl rand -hex 32`.
3. Hub variables:
   - `DATABASE_URL`
   - `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`
   - `BETTER_AUTH_BASE_URL`: the public URL (`https://triage.example.com`)
   - `HUB_DATA_DIR` on a persistent volume
   - `PORT` (3000 in the image)
4. Terminate TLS in front of the hub.
5. Sign up in the portal and follow [SELF_HOST.md](SELF_HOST.md).

The hub validates its variables at startup (`apps/hub/src/env.ts`), exits on a missing or malformed value, and runs migrations on every start. Secrets are runtime variables only, never build arguments.

Size the hub for its sidecars: each live deployment is a Bun process, and each PR event spawns a short-lived child run.

### Docker Compose

`docs/compose.yml` runs Postgres and the hub at `http://localhost:3000`:

```sh
cp .env.example .env   # fill the four secrets
docker compose -f docs/compose.yml up --build
```

### Railway

1. Add a Postgres service.
2. Add a service from this repo with Dockerfile `docs/Dockerfile` and a public domain on port 3000. Variables: the four secrets, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_BASE_URL` (the public URL), `HUB_DATA_DIR=/data`, `PORT=3000`. Attach a volume at `/data`.

Render is the same: a Postgres instance and one Docker web service with a disk at `HUB_DATA_DIR`.

## Portal hosted separately

Build `apps/web` (`bun run --cwd apps/web build`) and host `apps/web/dist` anywhere that fits one of these:

- **Rewrite `/api` to the hub** (works on any domains). Leave `VITE_HUB_URL` unset. On Vercel:

  ```json
  { "rewrites": [{ "source": "/api/:path*", "destination": "https://<hub-domain>/api/:path*" }, { "source": "/(.*)", "destination": "/index.html" }] }
  ```

  Set `BETTER_AUTH_BASE_URL` on the hub to the portal's public URL.

- **Same parent domain, no rewrite** (`triage.example.com` and `api.example.com`). Build with `VITE_HUB_URL=https://api.example.com`; set `PORTAL_ORIGIN=https://triage.example.com` and `BETTER_AUTH_BASE_URL=https://api.example.com` on the hub. The hub allows exactly that origin with credentials.

Unrelated domains without a rewrite (for example `*.vercel.app` and `*.up.railway.app`) do not work: browsers do not send the session cookie across sites.

## Splitting sidecars out later

Sidecars start through Interchange's `SidecarProvisioner` interface. The local-process provisioner is registered in `apps/hub/src/server.ts`; a remote provisioner (QEMU, Kubernetes, E2B) replaces it there. Remote sidecars dial the hub's `/api/sidecars/ws`; set `HUB_SIDECAR_WEBSOCKET_URL` to an address they can reach.

## Known limitations

- A hub restart stops its local sidecars, but their deployments still read as live, so events are not processed until the workflows are redeployed. There is no recovery step yet.
- The hub carries an Interchange patch (INTR-647); see `vendor/interchange/VENDORED.md`.
