# Deploy

Three services, one public domain:

| Service | Image | State |
| --- | --- | --- |
| Postgres | any managed or self-run Postgres | `DATABASE_URL` |
| Hub | `docs/Dockerfile` target `hub`: Interchange hub, webhooks, GitHub bridge, sidecars | volume at `HUB_DATA_DIR` |
| Web | `docs/Dockerfile` target `web`: Caddy serving the portal and proxying `/api` to the hub | none |

The hub sends no CORS headers, so the browser must reach it on the portal's origin. The web service is the only public endpoint; GitHub webhooks also arrive through it at `/api/hooks/...`.

## Single server (v1)

The hub runs sidecars as local child processes, one per live deployment, on its own machine. This is the cheapest setup and the one supported today.

1. Provision Postgres. Add `?sslmode=require` to its URL when reached over the public internet.
2. Generate four secrets, one per variable: `openssl rand -hex 32`.
3. Hub variables:
   - `DATABASE_URL`
   - `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`
   - `BETTER_AUTH_BASE_URL`: the public URL (`https://triage.example.com`)
   - `HUB_DATA_DIR` on a persistent volume
   - `PORT` (3000 in the images)
4. Web: build argument `VITE_HUB_URL` set to the same public URL; runtime variable `HUB_UPSTREAM` set to the hub's private `host:port`.
5. Terminate TLS in front of the web service.
6. Sign up in the portal and follow [SELF_HOST.md](SELF_HOST.md).

The hub validates its variables at startup (`apps/hub/src/env.ts`), exits on a missing or malformed value, and runs migrations on every start. Secrets are runtime variables only, never build arguments.

Size the hub for its sidecars: each live deployment is a Bun process, and each PR event spawns a short-lived child run.

### Docker Compose

`docs/compose.yml` runs all three on one host at `http://localhost:8080`:

```sh
cp .env.example .env   # fill the four secrets
docker compose -f docs/compose.yml up --build
```

### Railway

1. Add a Postgres service.
2. Add a service from this repo: Dockerfile `docs/Dockerfile`, target `hub`, no public domain. Variables: the four secrets, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_BASE_URL`, `HUB_DATA_DIR=/data`, `PORT=3000`. Attach a volume at `/data`.
3. Add a service with target `web` and a public domain on port 8080. Variables: `VITE_HUB_URL` (the public URL), `HUB_UPSTREAM=${{hub.RAILWAY_PRIVATE_DOMAIN}}:3000`.

Render is the same: a Postgres instance, a private hub service with a disk at `HUB_DATA_DIR`, and a public web service.

## Splitting sidecars out later

Sidecars start through Interchange's `SidecarProvisioner` interface. The local-process provisioner is registered in `apps/hub/src/server.ts`; a remote provisioner (QEMU, Kubernetes, E2B) replaces it there. Remote sidecars dial the hub's `/api/sidecars/ws`; set `HUB_SIDECAR_WEBSOCKET_URL` to an address they can reach.

## Known limitations

- A hub restart stops its local sidecars, but their deployments still read as live, so events are not processed until the workflows are redeployed. There is no recovery step yet.
- The hub carries an Interchange patch (INTR-647); see `vendor/interchange/VENDORED.md`.
