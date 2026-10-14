# Local development

Runs the hub (`apps/hub`, :3000) and portal (`apps/web`, :5173) against a local Postgres. The portal sets everything else up after you sign in. Production setup lives in [DEPLOY.md](DEPLOY.md).

## 1. Prerequisites

- Bun 1.4+ (CI runs 1.4.2)
- Postgres 15+ (Homebrew or Docker)
- A GitHub account that can create GitHub Apps and own a sandbox repository

```sh
bun install
```

## 2. Database

Create an empty database; the hub migrates it on boot.

```sh
createdb interchange
# or: docker run -d --name corbits-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=interchange -p 5432:5432 pgvector/pgvector:pg16
```

## 3. Environment

```sh
cp .env.example .env
```

Set the four secrets to different `openssl rand -hex 32` values and set `DATABASE_URL` to your database. Nothing else is required. Run everything from the repo root so both services inherit the root `.env`.

## 4. Run

```sh
bun run dev
```

Hub on http://localhost:3000, portal on http://localhost:5173 (it proxies `/api` to the hub and bundles the workflows on start). Restart after changing `apps/hub` or `packages/`; only the portal hot-reloads.

## 5. Set up in the portal

Follow [Set up in the portal](SELF_HOST.md#set-up-in-the-portal) against http://localhost:5173, using a sandbox repository. GitHub App credentials and the model key go to the hub vault, not `.env`.

### Webhooks on localhost (unverified)

The App's webhook URL is built from the hub origin that starts the manifest flow, so a localhost hub registers `http://localhost:3000/api/hooks/…`, which GitHub cannot reach. For live PR events, forward GitHub to `http://localhost:3000/api/hooks/<tenant-id>/github-hook` with a tunnel or a smee channel and set that URL in the App's settings on GitHub.

## GitHub emulator (no GitHub account)

`emulate.config.yaml` seeds org `acme`, repo `acme/widgets`, user `octocat` (token `octocat_token`), and App `12345` installed on `acme/widgets`. The emulator sends signed `pull_request`, review and comment webhooks to the App's `webhook_url`; it does not send `installation` events.

1. Start the stack against it: `GITHUB_API_ORIGIN=http://localhost:4000 VITE_GITHUB_API_ORIGIN=http://localhost:4000 bun run dev`.
2. Create an account and copy the webhook URL shown under Connect → **Connect an existing GitHub App instead**.
3. Uncomment `webhook_url` in `emulate.config.yaml` with that URL, then start the emulator: `npx emulate start --service github --generated-secrets-file .emulate-secrets.json`.
4. In Connect, enter App ID `12345`, slug `corbits-triage`, the PEM from `.emulate-secrets.json`, and webhook secret `emulate-webhook-secret`. Then add a decision model (**Add my own provider**, any HTTPS endpoint).
5. Register the repository by sending the installation event GitHub would send:

   ```sh
   BODY='{"action":"added","installation":{"id":100,"account":{"login":"acme"}},"repository_selection":"selected","repositories_added":[{"full_name":"acme/widgets"}],"repositories_removed":[]}'
   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac emulate-webhook-secret | sed 's/^.* //')
   curl -X POST "<webhook-url>" -H 'content-type: application/json' -H 'x-github-event: installation_repositories' \
     -H "x-github-delivery: $(date +%s)" -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"
   ```

6. Turn on triage for `acme/widgets`, then open a pull request as `octocat` through `http://localhost:4000` (`Authorization: Bearer octocat_token`). The emulator delivers the webhook and triage runs.

Restarting the emulator regenerates the App key; reconnect the App after each restart or pin `private_key` in the config.

## Tests and typecheck

```sh
bun run test     # unit + integration; hub tests need Postgres
bun run check    # typecheck web, tooling, hub
bun run lint
```

Scripts are listed in [IMPLEMENTATION.md](IMPLEMENTATION.md#scripts).

## Troubleshooting

- **Hub exits on boot naming a secret**: one of the four keys is missing or not 64 hex characters.
- **"No decision model offering found"**: save Settings → Model.
- **"Could not deploy triage workflows"**: the notice carries the hub's reason. Reload to retry.
- **New PRs never reach triage**: the hub logs `stale_deployment` when the tenant has no live pr-triage deployment for the repository's host (`pr-triage-github` or `pr-triage-bitbucket-datacenter`). Reload the portal, or wait about two minutes for the hub to redeploy it.
- **Portal shows `HTTP 404` from a hub route**: the hub process is older than the code. Restart `bun run dev`.
