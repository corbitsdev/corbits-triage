# Self-host

What you need to run Corbits Triage yourself: the services, every setting,
the GitHub App, a decision model key and, optionally, email. How to run the
image on a given platform is in [DEPLOY.md](DEPLOY.md).

## What you need

- Postgres 15+.
- One machine or container for the hub, from the root `Dockerfile`, with a
  persistent volume for `HUB_DATA_DIR` and a public HTTPS domain. GitHub
  must reach it to deliver webhooks.
- A GitHub account or organization that can create a GitHub App.
- An API key for a System One model (Jev), from TypeSafe, Vercel AI Gateway,
  OpenCode Zen, or any System One–compatible provider.
- Optional: a Google OAuth client for sign-in, and an SMTP account for invite
  emails.

## Configuration

The hub reads only these variables (`apps/hub/src/env.ts`), validates them at
startup and exits naming any that is missing or malformed. Blank counts as
unset. Secrets are runtime variables, never build arguments. `.env.example`
lists the same set.

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
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact emails and `@domains`, for example `@example.com,friend@example.org`. Requires Google and turns email/password sign-in off, since only Google verifies the address. Checked at every sign-in, so existing accounts outside it are locked out too. Invites to addresses outside it are refused. |

### Email

Admins invite teammates from the portal. The invitee joins by opening the
sign-in link sent to that address; it works once and expires after 15
minutes, and admins can resend it. An account whose address is not verified
(an email/password sign-up) cannot be invited. With email set up, anyone can
set or reset their password from the sign-in page.

| Variable | Value |
| --- | --- |
| `SMTP_URL` | Any SMTP provider, credentials in the URL: `smtps://user:password@smtp.example.com:465`, or `smtp://` to upgrade with STARTTLS when offered. Percent-encode special characters in the password. |
| `EMAIL_FROM` | The sender, for example `Triage <triage@example.com>`, on a domain the provider accepts. |

Set both or neither. Without them the portal shows each invite link to copy
and send yourself. That link signs nobody in: without email, invitees must
sign in with Google first.

### Portal hosting

| Variable | Value |
| --- | --- |
| `PORTAL_DIR` | Directory of the built portal the hub serves. The image sets it. |
| `PORTAL_ORIGIN` | The portal's origin when it is hosted apart from the hub under the same parent domain. The hub allows exactly that origin with credentials, and invite links point there. Unset: invite links use `BETTER_AUTH_BASE_URL`. |

### Triage tuning

All optional; the defaults suit most installs.

| Variable | Default | Effect |
| --- | --- | --- |
| `TRIAGE_RECONCILE_INTERVAL_MS` | 300000 | How often the hub re-queues open pull requests whose latest commit has no verdict. |
| `TRIAGE_BATCH_SIZE` | 5 | Pull request heads one catch-up run carries at most. |
| `TRIAGE_MAX_IN_FLIGHT` | 5 | Heads a tenant may have queued or running at once. Higher trades throughput for a bigger pack each rotation has to receive. |
| `TRIAGE_CAPPED_RETRY_MS` | 21600000 | How long a head that ran out of attempts waits before a fresh set. |
| `TRIAGE_ROTATE_AFTER_RUNS` | 15 | Runs a pr-triage deployment's log may hold before the hub deploys a fresh copy. |
| `TRIAGE_COALESCE_QUIET_MS` | 30000 | Quiet time before a pull request's webhook events go out as one run; at most four times this after the first. A new commit or a newly opened pull request waits only 3 seconds (or this, if shorter). Must stay below 150000. |
| `TRIAGE_COORDINATOR` | off | `on` runs each coalesced pull request in a worker deployment of its own, spawned from the host's live pr-triage deployment and released when its run ends, instead of mailing that deployment. |
| `TRIAGE_WORKERS_GLOBAL` | 8 | Worker deployments alive at once on this hub, with the coordinator on. |
| `TRIAGE_WORKERS_PER_TENANT` | 4 | Worker deployments one workspace may have alive at once. |
| `TRIAGE_SPAWNS_PER_SECOND` | 2 | Worker deployments the coordinator starts per second. |

### Hub and sidecars

| Variable | Default | Effect |
| --- | --- | --- |
| `HUB_SIDECAR_STOP_TIMEOUT_MS` | 25000 | How long each local sidecar gets to finish writing run state after SIGTERM before SIGKILL. The platform's drain time must exceed it. |
| `HUB_SIDECAR_WEBSOCKET_URL` | `ws://127.0.0.1:<PORT>/api/sidecars/ws` | The address sidecars dial. Leave it unset: it matters only for sidecars on another machine, which are not supported yet. |
| `GITHUB_API_ORIGIN` | `https://api.github.com` | GitHub API origin; for the local emulator only. |
| `PG_SCHEMA` | default `search_path` | Postgres schema. |
| `DB_STATEMENT_TIMEOUT_MS` | 60000 | Postgres statement timeout. |

### Interchange settings

Unset keeps the default shown: Interchange's stock default, or the hub's own
where marked. Durations are whole numbers ending in `s`, `m`, `h` or `d`.

| Variable | Default |
| --- | --- |
| `HUB_MAX_TARBALL_BYTES` | 10485760 |
| `HUB_AGENT_GC_PACK_THRESHOLD` | 64 |
| `HUB_AGENT_GC_LOOSE_THRESHOLD` | 2048 |
| `HUB_AGENT_GC_WARN_BYTES` | 268435456 |
| `HUB_PROBE_TIMEOUT_MS` | 60000 |
| `HUB_MAIL_HOLD_TTL_MS` | 900000 (hub default) |
| `HUB_MAIL_ACK_RETRY_INTERVAL_MS` | 30000 (hub default) |
| `HUB_MAIL_ACK_MAX_RETRIES` | 10 (hub default) |
| `WORKFLOW_DEFAULT_MAX_LIFETIME` | `7d` (above zero) |
| `WORKFLOW_DEFAULT_MAX_DISCONNECTED` | `15m` (above zero) |
| `WORKFLOW_DEFAULT_RETENTION_COMPLETED` | `30m` |
| `WORKFLOW_DEFAULT_RETENTION_FAILED` | `24h` |
| `WORKFLOW_DEFAULT_RETENTION_CANCELLED` | `1h` |

The three hub defaults are above stock because triage mail is routed: only the
router's acknowledgement retries keep it alive while a pack receive holds the
connection queue for minutes.

## Set up in the portal

1. **Sign up.** The portal creates your workspace (tenant) on first sign-in.
2. **Create the GitHub App** from Connect → **Create GitHub App**, and confirm
   the prefilled manifest on GitHub. GitHub returns to the hub, which
   exchanges the one-time code and stores the App in the vault; nothing secret
   reaches the browser. The App's webhook URL is built from the hub origin
   that started the flow, so start it from the public URL.

   To reuse an App instead, expand **Connect an existing GitHub App** and
   enter its App ID, private key and webhook secret. Set its webhook URL to
   the one shown, with these permissions and events:

   - Permissions: Pull requests, Issues and Contents: write; Checks, Members
     and Metadata: read.
   - Events: Pull request, Pull request review, Issue comment, Check run,
     Push, Installation, Installation repositories.

   An App created before the Push event was added keeps working, but a change
   to its repositories' `.corbits-triage.yml` is read only after the hub
   restarts until Push is ticked under the App's settings → Permissions &
   events. Contents
   access already covers it, so installations are not asked to approve
   anything new.
3. **Choose repositories on GitHub**. The hub records them from GitHub's
   installation events, with triage off; nothing runs yet.
4. **Add the decision model** (during onboarding, or the **Decision model** section of Settings). Pick
   TypeSafe, Vercel AI Gateway or OpenCode Zen and paste an API key, or **Add
   my own provider** with a System One–compatible base URL (requests go to
   it + `/systemone`), model and key. The key goes to the hub's vault. Every
   save deploys `pr-triage-github`, `pr-triage-bitbucket-datacenter` (each
   only once its host is connected) and `pr-triage-historical` afresh; triage is not
   live until then.
5. **Turn on triage.** Open a repository under Repositories and turn on
   **Triage pull requests in this repository**; the rules, steps and labels
   below it save as you change them, and turning triage on triages its open
   pull requests. New pull request events are triaged from then on. **Triage
   open pull requests again** re-runs it. To keep the policy in the
   repository instead, use **Export to repository** on the Policy card and
   merge the pull request it opens; from then on the hub reads
   `.corbits-triage.yml` again on every push to the default branch that
   changes it (see
   [Policy file](PRODUCT.md#policy-file)).
6. **Verify.** Open a test pull request; it appears in the Inbox once its
   triage run completes.

GitHub credentials stay in the vault and never reach workflow code or the
browser; see [Tenancy and authority](ARCHITECTURE.md#tenancy-and-authority).

## Backups

- **Postgres**: tenants, accounts, the vault, deployments and triage records.
- **The `HUB_DATA_DIR` volume**: run history, workflow sources and sidecar
  state.
- **The four keys** (`BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
  `PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`). Store
  them apart from the database: a restored database without the same keys
  has an unreadable vault.

## Upgrading

Pull the new version, rebuild the image and redeploy. The hub runs
migrations on every start; nothing else is needed.

- Merges need Contents: write, and a step whose `when` names a GitHub team
  needs Members: read. An App created before these were requested keeps its old
  permissions until an owner accepts the new ones on GitHub.
- A hub that ran the build creating `corbits_triage_tenant_migration` can drop
  it: `DROP TABLE IF EXISTS corbits_triage_tenant_migration;`
- A hub that ran the build creating `corbits_triage_verdict_backfill` can drop
  it: `DROP TABLE IF EXISTS corbits_triage_verdict_backfill;`
- A hub that ran a build creating `corbits_github_manifest_state` can drop
  it: `DROP TABLE IF EXISTS corbits_github_manifest_state;`
- The hub drops `corbits_triage.invitation` on start; invites still open then
  are gone and need sending again.
- Triage's tables move from `public.corbits_triage_*` into the
  `corbits_triage` schema on first start. If an older build runs after that,
  it recreates empty `public.corbits_triage_*` tables and the next start
  stops with "relation already exists"; drop the empty public ones
  (`DROP TABLE public.corbits_triage_verdict, public.corbits_triage_do_run,
  public.corbits_triage_invitation;`) and start again.
