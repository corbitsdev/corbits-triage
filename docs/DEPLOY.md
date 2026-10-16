# Deploy

How to run the hub image. What to configure is in [SELF_HOST.md](SELF_HOST.md).

Two services:

| Service | Image | State |
| --- | --- | --- |
| Postgres | any managed or self-run Postgres | `DATABASE_URL` |
| Hub | `Dockerfile`: Interchange hub, webhooks, GitHub bridge, sidecars, and the built portal | volume at `HUB_DATA_DIR` |

The hub serves the portal itself (`PORTAL_DIR`, set by the image), so one public domain covers the portal, the API and GitHub webhooks (`/api/hooks/...`).

## Single server (v1)

The hub runs sidecars as local child processes, one per live deployment, on its own machine. This is the cheapest setup and the one supported today.

1. Provision Postgres. Add `?sslmode=require` to its URL when reached over the public internet.
2. Set the hub's required variables ([SELF_HOST.md](SELF_HOST.md#required)) and any optional ones. The platform's drain time must exceed `HUB_SIDECAR_STOP_TIMEOUT_MS` (default 25000): sidecars stop in parallel, so shutdown takes about one timeout. On Railway set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (for example 30).
3. On the hub's database role, set `idle_in_transaction_session_timeout` to `10min`:

   ```sql
   alter role <hub role> set idle_in_transaction_session_timeout = '10min';
   ```

   A workflow-run pack receive holds the deployment's allocation row lock for its whole transaction. If that receive wedges, the lock is held until the session ends; with the timeout, Postgres ends it after ten minutes, the hub logs a failed receive and the sidecar pushes again.
4. Terminate TLS in front of the hub.
5. Sign up in the portal and follow [SELF_HOST.md](SELF_HOST.md#set-up-in-the-portal).

Size the hub for its sidecars: each live deployment is a Bun process, and each PR event spawns a short-lived child run.

### Docker Compose

`compose.yml` runs Postgres and the hub at `http://localhost:3000`:

```sh
cp .env.example .env   # fill the four secrets
docker compose up --build
```

### Railway

1. Add a Postgres service.
2. Add a service from this repo (Railway builds the root `Dockerfile`) with a public domain on port 3000. Variables: the four secrets, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_BASE_URL` (the public URL), `HUB_DATA_DIR=/data`, `PORT=3000`. Attach a volume at `/data`.

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

Sidecars start through drivers registered in `apps/hub/src/server.ts`: local processes first, then Docker when `HUB_SIDECAR_DOCKER_SOCKET` and `HUB_SIDECAR_DOCKER_IMAGE` are set. A workflow that requires `isolation:workload` lands on Docker. Railway gives no Docker socket, so there it needs a Docker host the hub can reach. Sidecars off the hub's machine dial `HUB_SIDECAR_WEBSOCKET_URL`, which should then be `wss://`. See [SIDECAR_DRIVERS.md](SIDECAR_DRIVERS.md).

## Isolated sidecars on E2B

A workflow that requires `isolation:workload` or `isolation:microvm` runs on E2B, one microVM per allocation, when it is configured:

1. Build the template from the repo root: `E2B_API_KEY=... bunx @e2b/cli template create corbits-sidecar` (reads `e2b.Dockerfile`; E2B does not take the multi-stage `Dockerfile`). Rebuild it for every hub release.
2. Set `HUB_SIDECAR_E2B_API_KEY`, `HUB_SIDECAR_E2B_TEMPLATE=corbits-sidecar` and `HUB_SIDECAR_WEBSOCKET_URL=wss://<hub host>/api/sidecars/ws`. A local hub needs a tunnel for that URL, for example `cloudflared tunnel --url http://localhost:3000`.

Each sandbox is tagged with its allocation, so a restarted hub finds it again. E2B kills a sandbox one hour after it starts, which bounds what a hub that dies without cleaning up can leak; an allocation that outlives that hour loses its sidecar (Hobby plan cap; not yet extended while held).

## Known limitations

- The hub carries Interchange patches; see `vendor/interchange/VENDORED.md`.
- Boot applies Interchange migration 0101: deleting a principal that still owns a credential is now refused (`credential.principal_id` FK is `ON DELETE RESTRICT`).
- A trigger right after a deploy or restart can return `409 deployment_not_ready` until the deployment records its credential resolution; retry it.
