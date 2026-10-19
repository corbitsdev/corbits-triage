# Self-host

How to run Corbits Triage yourself: what you need, how to run the image, the
portal setup, and every setting. Local development is in [DEV.md](DEV.md).

## What you need

- Postgres 15+.
- One machine or container for the hub, built from the root `Dockerfile`, with
  a persistent volume for `HUB_DATA_DIR` and a public HTTPS domain. GitHub must
  reach it to deliver webhooks. The hub serves the portal, the API and the
  webhooks (`/api/hooks/...`) on that one domain.
- A GitHub account or organization that can create a GitHub App.
- An API key for a System One model (Jev), from TypeSafe, Vercel AI Gateway,
  OpenCode Zen, or any System One–compatible provider.
- Optional: a Google OAuth client for sign-in, an SMTP account for invite
  emails, an Anthropic key and Docker for [code review](PRODUCT.md#code-review).

Size the hub for its sidecars: each triage and code review runs in a Bun
process of its own (about 1 GiB at peak).

## Run it

### Docker Compose

`compose.yml` runs Postgres and the hub at `http://localhost:3000`:

```sh
cp .env.example .env   # fill the four secrets: openssl rand -hex 32 each
docker compose up --build
```

### Railway or Render

1. Add a Postgres service.
2. Add a service from this repository (it builds the root `Dockerfile`) with a
   public domain on port 3000 and a volume at `/data`. Variables: the four
   secrets, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_BASE_URL`
   (the public URL), `HUB_DATA_DIR=/data`, `PORT=3000`, and on Railway
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`.

Render is the same: a Postgres instance and one Docker web service with a disk
at `HUB_DATA_DIR`.

### Any other host

1. Provision Postgres. Add `?sslmode=require` to its URL when it is reached
   over the public internet.
2. Set the [required variables](#required) and any optional ones.
3. Give the platform a drain time longer than `HUB_SIDECAR_STOP_TIMEOUT_MS`
   (default 25 seconds); sidecars stop in parallel, so shutdown takes about
   one timeout.
4. Terminate TLS in front of the hub.

### Database role

On the hub's database role, end wedged transactions after ten minutes, so a
stuck run-log receive releases its lock and the sidecar pushes again:

```sql
alter role <hub role> set idle_in_transaction_session_timeout = '10min';
```

## Set up in the portal

1. **Sign up.** The first sign-in creates your workspace.
2. **Create the GitHub App** with **Create GitHub App** and confirm the
   prefilled form on GitHub. The private key goes to the hub's vault and never
   reaches the browser. The App's webhook URL is built from the address that
   started the flow, so start it from the public URL.

   To reuse an App, expand **Connect an existing GitHub App instead**, enter its
   App ID, slug, private key and webhook secret, and set its webhook URL to the
   one shown. It needs:

   - Permissions: Pull requests, Issues and Contents: write; Checks, Members
     and Metadata: read.
   - Events: Pull request, Pull request review, Issue comment, Check run,
     Check suite, Push, Installation, Installation repositories.

   Bitbucket Data Center connects with an access token instead; see
   [BITBUCKET_DATACENTER.md](BITBUCKET_DATACENTER.md).
3. **Choose repositories on GitHub.** They arrive with triage off; nothing
   runs yet.
4. **Add the decision model** (during onboarding, or Settings → Triage).
   Pick TypeSafe, Vercel AI Gateway or OpenCode Zen and paste an API key, or
   **Add my own provider** with a System One–compatible base URL (requests go to it + `/systemone`), model and key.
   Saving deploys the triage workflows; triage is live once that finishes.
5. **Add a policy file.** A repository's rules and actions come only from
   `.corbits-triage.yml` on its default branch ([Policy file](PRODUCT.md#policy-file)).
   A repository without one offers **Start a policy file**: **Open the pull
   request** and merge it.
6. **Turn on triage.** Open the repository under Repositories and turn on
   **Triage pull requests in this repository**. Its open pull requests are
   triaged, then every new pull request event. Verdicts appear in the Inbox.

## Configuration

The hub reads only these variables (`apps/hub/src/env.ts`), validates them at
startup and exits naming any that is missing or malformed. Blank counts as
unset. Secrets are runtime variables, never build arguments. `.env.example`
lists the same set. GitHub App credentials and model keys are not variables:
they live in the hub's vault.

### Required

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://` or `postgresql://` URL. Add `?sslmode=require` when reached over the public internet. |
| `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY` | Four different 32-byte hex values: `openssl rand -hex 32` each. Keep them stable: they sign sessions and GitHub App setup state, and encrypt stored credentials. |
| `BETTER_AUTH_BASE_URL` | The public URL users open, for example `https://triage.example.com`. |
| `PORT` | Port the hub listens on. The image does not set it; use 3000 to match its `EXPOSE`. |
| `HUB_DATA_DIR` | Run history, workflow sources and sidecar state. A persistent volume. |

### Sign-in

By default anyone who reaches the hub can create an account with email and
password.

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enable "Continue with Google". Set both or neither. Create a Google Cloud OAuth client (Web application) with redirect URI `<BETTER_AUTH_BASE_URL>/api/auth/callback/google`. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact emails and `@domains`, for example `@example.com,friend@example.org`. Requires Google and turns email/password sign-in off, since only Google verifies the address. Checked at every sign-in, so existing accounts outside it are locked out, and invites outside it are refused. |

### Email

Admins invite teammates from the portal; the invitee gets a one-time sign-in
link that works once, expires after 15 minutes and can be resent. An account
whose address is not verified (an email and password sign-up) cannot be
invited. With email set up, anyone can also reset their password from the
sign-in page.

| Variable | Value |
| --- | --- |
| `SMTP_URL` | Any SMTP provider, credentials in the URL: `smtps://user:password@smtp.example.com:465`, or `smtp://` to upgrade with STARTTLS when offered. Percent-encode special characters in the password. |
| `EMAIL_FROM` | The sender, for example `Triage <triage@example.com>`, on a domain the provider accepts. |

Set both or neither. Without them the portal shows each invite link to copy
and send yourself, and invitees must sign in with Google.

### Portal hosting

| Variable | Value |
| --- | --- |
| `PORTAL_DIR` | Directory of the built portal the hub serves. The image sets it. |
| `PORTAL_ORIGIN` | The portal's origin when it is [hosted apart from the hub](#portal-hosted-separately) under the same parent domain. The hub allows exactly that origin with credentials, and invite links point there. |

### Triage tuning

All optional; the defaults suit most installs.

| Variable | Default | Effect |
| --- | --- | --- |
| `TRIAGE_RECONCILE_INTERVAL_MS` | 300000 | How often the hub re-queues open pull requests whose latest commit has no verdict. |
| `TRIAGE_MAX_IN_FLIGHT` | 5 | Pull request heads a workspace may have queued or running at once. |
| `TRIAGE_CAPPED_RETRY_MS` | 21600000 | How long a head that ran out of attempts waits before a fresh set. |
| `TRIAGE_ROTATE_AFTER_RUNS` | 15 | Runs a pr-triage deployment's log may hold before the hub deploys a fresh copy. |
| `TRIAGE_COALESCE_QUIET_MS` | 30000 | Quiet time before a pull request's webhook events go out as one run, at most four times this after the first. A new commit, an opened, reopened or ready pull request, an approval or a change request waits only 3 seconds. Must stay below 150000. |

### Hub and sidecars

| Variable | Default | Effect |
| --- | --- | --- |
| `HUB_SIDECAR_STOP_TIMEOUT_MS` | 25000 | How long each local sidecar gets to finish writing run state after SIGTERM before SIGKILL. |
| `HUB_SIDECAR_WEBSOCKET_URL` | `ws://127.0.0.1:<PORT>/api/sidecars/ws` | The address sidecars dial. Leave it unset for Docker [on another machine](provisioners/docker-remote.md), whose sidecars dial `BETTER_AUTH_BASE_URL` over `wss://`. |
| `DOCKER_HOST` | the docker CLI's context, else its default sockets | The daemon for the [Docker provisioner](provisioners/docker.md). |
| `DOCKER_CONTEXT` | the docker CLI's current context | The docker CLI context to use when `DOCKER_HOST` is unset. |
| `DOCKER_TLS_VERIFY` | unset | Any non-empty value, even `0`, as with the docker CLI: reach the daemon over TLS. Required for a daemon on another machine. |
| `DOCKER_CERT_PATH` | `$HOME/.docker` | Absolute path of the directory holding `ca.pem`, `cert.pem` and `key.pem`. |
| `E2B_API_KEY` | unset | Registers the [E2B provisioner](provisioners/e2b.md), which runs each isolated sidecar in an E2B sandbox. |
| `GITHUB_API_ORIGIN` | `https://api.github.com` | GitHub API origin; for the local emulator only. |
| `PG_SCHEMA` | default `search_path` | Postgres schema. |
| `DB_STATEMENT_TIMEOUT_MS` | 60000 | Postgres statement timeout. |

### Interchange settings

Unset keeps the default shown. Durations are whole numbers ending in `s`, `m`,
`h` or `d`.

| Variable | Default |
| --- | --- |
| `HUB_MAX_TARBALL_BYTES` | 10485760 |
| `HUB_AGENT_GC_PACK_THRESHOLD` | 64 |
| `HUB_AGENT_GC_LOOSE_THRESHOLD` | 2048 |
| `HUB_AGENT_GC_WARN_BYTES` | 268435456 |
| `HUB_PROBE_TIMEOUT_MS` | 60000 |
| `HUB_MAIL_HOLD_TTL_MS` | 900000 |
| `HUB_MAIL_ACK_RETRY_INTERVAL_MS` | 30000 |
| `HUB_MAIL_ACK_MAX_RETRIES` | 10 |
| `WORKFLOW_DEFAULT_MAX_LIFETIME` | `7d` (above zero) |
| `WORKFLOW_DEFAULT_MAX_DISCONNECTED` | `15m` (above zero) |

The three mail defaults are above Interchange's stock ones, so routed triage
mail survives a long run-log receive.

## Portal hosted separately

Build `apps/web` (`bun run --cwd apps/web build`) and host `apps/web/dist`
one of two ways:

- **Rewrite `/api` to the hub** (any domains). Leave `VITE_HUB_URL` unset and
  set `BETTER_AUTH_BASE_URL` on the hub to the portal's public URL. On Vercel:

  ```json
  { "rewrites": [{ "source": "/api/:path*", "destination": "https://<hub-domain>/api/:path*" }, { "source": "/(.*)", "destination": "/index.html" }] }
  ```

- **Same parent domain, no rewrite** (`triage.example.com` and
  `api.example.com`). Build with `VITE_HUB_URL=https://api.example.com`; set
  `PORTAL_ORIGIN=https://triage.example.com` and
  `BETTER_AUTH_BASE_URL=https://api.example.com` on the hub.

Unrelated domains without a rewrite (for example `*.vercel.app` and
`*.up.railway.app`) do not work: browsers do not send the session cookie
across sites.

## Where sidecars run

Sidecars run as child processes on the hub's machine by default. Code review
needs a sidecar of its own, so it runs only once an isolated place is set up.
Settings → Code review → **Where it runs** lists every place this server
offers, with the `.env` lines and guide for each; code review uses the first
ready one in the order shown and waits there when it is full.
[provisioners/README.md](provisioners/README.md) covers each option.

## Backups

- **Postgres**: workspaces, accounts, the vault, deployments and verdicts.
- **The `HUB_DATA_DIR` volume**: run history, workflow sources and sidecar
  state.
- **The four keys.** Store them apart from the database: a restored database
  without the same keys has an unreadable vault.

## Upgrading

Pull the new version, rebuild the image and redeploy. The hub runs its
migrations on every start.

- A GitHub App created by an earlier build may lack permissions or events
  added since. Accept new permissions (Contents: write, Members: read) when
  GitHub asks an owner, and tick new events (Push, Check suite) under the App's
  settings → Permissions & events. Until then, a policy file change committed
  straight to the default branch, rather than merged in a pull request, is
  read only after a hub restart, and a pull request waiting for CI is triaged after
  the quiet time instead of seconds after CI finishes.
- Rules saved in the portal by an earlier build keep running until they move
  into a policy file: the repository's Policy section offers **Move this
  repository's rules into a policy file**.
- Earlier builds left tables the hub no longer uses; drop them if present:
  `DROP TABLE IF EXISTS corbits_triage_tenant_migration, corbits_triage_verdict_backfill, corbits_github_manifest_state;`
- The hub drops `corbits_triage.invitation` on start; invites still open then
  are gone and need sending again.
- Triage's tables moved from `public.corbits_triage_*` into the
  `corbits_triage` schema. If an older build runs after that, it recreates
  empty public tables and the next start stops with "relation already
  exists": drop them (`DROP TABLE public.corbits_triage_verdict,
  public.corbits_triage_do_run, public.corbits_triage_invitation;`) and start
  again.

## Known limitations

- The hub carries Interchange patches; see `vendor/interchange/VENDORED.md`.
- Run one hub replica: its triage queue lives in memory.
- Deleting a principal that still owns a credential is refused (Interchange
  migration 0101).
- A trigger right after a deploy or restart can answer `409
  deployment_not_ready` until the deployment has resolved its credentials;
  retry it.
