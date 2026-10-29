# Local development

Runs the hub (`apps/hub`, :3000) and portal (`apps/web`, :5173) against a local Postgres. The other way to run it is in the [README](../README.md#get-started). The portal sets everything else up after you sign in. Running it for real is in [SELF_HOST.md](SELF_HOST.md).

## 1. Prerequisites

- Bun 1.4.4+, the version CI runs. `bun run check` and the portal build need `bun check`, which older Bun lacks; on one older than 1.4.3 they stop with `bun check needs Bun 1.4.3 or newer`, and `bun upgrade` fixes it
- Postgres 15+ (Homebrew or Docker)
- A GitHub account that can create GitHub Apps and own a sandbox repository

```sh
bun install
```

## 2. Database

Create an empty database whose role has a password: the migration tool refuses a `DATABASE_URL` without one (`Please provide required params for Postgres driver: [x] password: ''`).

```sh
docker run -d --name corbits-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=interchange -p 5432:5432 pgvector/pgvector:pg16
# or, on a Homebrew Postgres:
createdb interchange
psql -d interchange -c "create role postgres login superuser password 'postgres'"
```

Either gives the `DATABASE_URL` in `.env.example`, `postgres://postgres:postgres@localhost:5432/interchange`, which the hub tests also use.

## 3. Environment

```sh
cp .env.example .env
```

Set the four secrets to different `openssl rand -hex 32` values and set `DATABASE_URL` to the database from step 2; leave the rest as it is. Run everything from the repo root so both services inherit the root `.env`.

## 4. Run

```sh
bun run dev
```

It first applies the database migrations (`bun run db:migrate`), then starts both services; the hub itself never migrates.

It packs the workflows into `apps/web/public/packages/` first. Hub on http://localhost:3000 (API only), portal on http://localhost:5173 (it proxies `/api` to the hub). As it starts, the hub publishes the packed workflows and rolls every workspace onto them. Restart after changing `apps/hub` or `packages/`; only the portal hot-reloads.

When no isolated place is registered, the hub prints one warning, `code_review_no_isolated_place`, and still starts; triage runs and code review does not. Docker on this machine needs no variable, only Docker running and the `corbits-triage-sidecar` image built ([steps 1 to 3](provisioners/docker.md#set-up)), optionally with `DOCKER_CONTEXT`. The other places need `DOCKER_HOST`, `DOCKER_TLS_CA`, `DOCKER_TLS_CERT`, `DOCKER_TLS_KEY`, `E2B_API_KEY`, `RAILWAY_SANDBOX_TOKEN` and `RAILWAY_SANDBOX_ENVIRONMENT_ID` ([docs/provisioners/](provisioners/)). Settings → Code review shows **Code review needs an isolated place to run** at the top, with the first place's `.env` lines and setup guide, until a place is in use.

## 5. Set up in the portal

Sign up at http://localhost:5173; the portal shows **Set up Triage** with two steps: Connect a source, then Repositories. A decision model is not part of setup and is not a variable in `.env`. Triage does not start until one is saved under Settings → Triage. Follow [Set up in the portal](SELF_HOST.md#set-up-in-the-portal), using a sandbox repository. GitHub App credentials, and a model key if you save one, go to the hub vault, not `.env`.

### Webhooks on localhost (unverified)

The App's webhook URL is built from `BETTER_AUTH_BASE_URL`, and GitHub refuses a manifest whose webhook URL it cannot reach, so a hub on localhost registers the App without a webhook and finds pull requests by polling. For live PR events, forward a tunnel or a smee channel to `http://localhost:3000/api/hooks/<tenant-id>/github-hook` (the URL shown under Connect → **Connect an existing GitHub App instead**), then in the App's settings on GitHub activate the webhook with the tunnel's public URL and a secret of your choosing, and save that secret in the portal through the same form with the App ID and a private key downloaded from the App's settings.

## GitHub emulator (no GitHub account)

`emulate.config.yaml` seeds org `acme`, repo `acme/widgets`, user `octocat` (token `octocat_token`), and App `12345` installed on `acme/widgets`. The emulator sends signed `pull_request`, review and comment webhooks to the App's `webhook_url`; it does not send `installation` events.

1. Start the stack against it: `GITHUB_API_ORIGIN=http://localhost:4000 VITE_GITHUB_API_ORIGIN=http://localhost:4000 bun run dev`.
2. Create an account and copy the webhook URL shown under Connect → **Connect an existing GitHub App instead**.
3. Uncomment `webhook_url` in `emulate.config.yaml` with that URL, then start the emulator: `npx emulate start --service github --generated-secrets-file .emulate-secrets.json`.
4. In Connect, enter App ID `12345`, the PEM from `.emulate-secrets.json`, and webhook secret `emulate-webhook-secret`, then open Repositories. Save a decision model under Settings → Triage (**Add my own provider**, any HTTPS endpoint).
5. Register the repository by sending the installation event GitHub would send:

   ```sh
   BODY='{"action":"added","installation":{"id":100,"account":{"login":"acme"}},"repository_selection":"selected","repositories_added":[{"full_name":"acme/widgets"}],"repositories_removed":[]}'
   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac emulate-webhook-secret | sed 's/^.* //')
   curl -X POST "<webhook-url>" -H 'content-type: application/json' -H 'x-github-event: installation_repositories' \
     -H "x-github-delivery: $(date +%s)" -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"
   ```

6. Turn on triage for `acme/widgets`, then open a pull request as `octocat` through `http://localhost:4000` (`Authorization: Bearer octocat_token`). The emulator delivers the webhook and triage runs.

Restarting the emulator regenerates the App key; reconnect the App after each restart or pin `private_key` in the config.

Code review against the emulator: the emulator ignores GitHub's diff media type and answers a pull request's JSON, which the hub refuses as no diff. Point `GITHUB_API_ORIGIN` at a small proxy in front of the emulator that answers `GET /repos/{owner}/{repo}/pulls/{number}` with 406 when it asks for a diff, as GitHub does for a very large pull request; the hub then builds the diff from the files' patches. Save an Anthropic key in Settings and turn code review on in `acme/widgets`'s policy file (its `code-review` block). A review calls Anthropic for every step; to try the wiring without spending, point the `anthropic` catalog provider's `baseURL` at a stand-in that answers `/v1/messages`, and deploy before the portal next reconciles the catalog.

## Tests and typecheck

```sh
bun run test     # unit + integration; hub tests need Postgres
bun run test:chain  # the live chain: hub, sidecars, listener, manager, judge; about ten minutes
bun run check    # typecheck web, tooling, extension, hub; bundle the hub
bun run lint
```

Hub tests connect to `postgres://postgres:postgres@localhost:5432/interchange` and ignore `DATABASE_URL`.

`bun run test:chain` (`tests/chain/`) runs its files two at a time, one scenario each, each isolated from the others. Each file starts a hub on a database of its own, serving a portal build, sets up a workspace through the portal's routes, waits for the hub to start its listener, and sends GitHub's webhooks to it. GitHub and the decision model are local stand-ins, so it needs no account or key; each hub's sidecars are local processes, and it installs the workflows' native modules from the npm registry as a deploy does. Code review needs an isolated sidecar, which a local process is not, so it is not part of the chain test.

The chain starts its hub with its waits short (`TIMINGS` and `MAIL_HOLD_MS` in `tests/chain/stack.ts`, set through the `TRIAGE_*_MS` variables in [SELF_HOST.md](SELF_HOST.md#triage-tuning) and `HUB_MAIL_HOLD_TTL_MS`). A scenario polls every 100 ms for the state it names and never sleeps for a fixed time, which `bun run lint` enforces under `tests/chain/`. The real waits left are stock's one-minute ping timeout in the scenarios that freeze a listener's sidecar, the one-minute mail hold `unstarted` waits out, and the manager's 30-second poll in `woken`. A failed shard is handled as the [Tests rules](../AGENTS.md#tests) say.

Each hub's full log, which holds its sidecars' and their workflow processes' output too, is written to `tmp/chain-logs/<test file>/hub-<time>-<id>.log` as the scenario runs, and a timeout names that directory and shows the last 80 lines. Run one file with `bun --conditions=intx-src test tests/chain/<file>`. When a CI shard fails, its `chain-hub-logs-<job index>` artifact holds the `tmp/chain-logs` directory, one subdirectory per test file in the shard.

`tests/model/` checks the rules in [INVARIANTS.md](INVARIANTS.md) across event orders. It runs the real GitHub listener and manager definitions in the test's own process through Interchange's `runLocal`, against the hub's own intake and manager routes on a database of its own and the chain's fake GitHub, with steps authorized against the grants a deployed run holds. Stock's deploy and stop-run routes are stood in for, mail between runs waits in a queue the test delivers, and webhooks enter at the hub's intake; [INVARIANTS.md](INVARIANTS.md#how-the-model-check-works) lists every stand-in and what it leaves out. It is a Postgres test, so `bun run test:postgres` runs it.

In CI the chain runs in five shards, each with its own list of files in `.github/workflows/ci.yml`; a new chain file must be added to one. A pull request that changes none of `apps/hub`, `apps/sidecar`, `apps/web/scripts`, `apps/web/src/lib`, `tooling/`, `packages/`, `tests/chain/`, `vendor/`, the lockfile, the root `package.json` or the CI workflow and setup actions skips the chain, so a change limited to the portal's pages and components, docs, e2e or research does not run it; every push to `main` runs it.

Scripts are listed in [IMPLEMENTATION.md](IMPLEMENTATION.md#scripts).

## Check a change locally

`packages/policy-check-action/src/cli.ts check [--base <ref>]`, run inside any clone, runs the base branch's rules that need no model on the working tree's change through the pr-triage definition, reading only local git ([README](../packages/policy-check-action/README.md#check-locally)).

## Troubleshooting

- **Hub exits on boot naming a secret**: one of the four keys is missing or not 64 hex characters.
- **"The workspace has no decision model"**: triage has not started. Save a decision model in the **Triage** section of Settings.
- **"Could not deploy triage workflows"**: the notice carries the hub's reason. Reload to retry.
- **New PRs never reach triage**: the host has no live listener (`triage-listener-github` or `triage-listener-bitbucket-datacenter`). Settings → Triage says why; the hub's `workflow_release_*` log lines say what the last roll did. A failed roll is tried again ten minutes later; restart the hub, or save the decision model again, to roll at once.
- **Portal shows `HTTP 404` from a hub route**: the hub process is older than the code. Restart `bun run dev`.
