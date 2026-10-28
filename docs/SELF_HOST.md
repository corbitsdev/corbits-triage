# Self-host

How to run Corbits Triage yourself: what you need, how to run the image, the
portal setup, and every setting. Local development is in [DEV.md](DEV.md).

## What you need

To try it on your machine, the requirements and portal address for each way
to run it are in the [README](../README.md#get-started).

GitHub cannot deliver webhooks to localhost, and it refuses to create an
App whose webhook URL it cannot reach. So when the hub runs on localhost,
**Create GitHub App** registers the App without a webhook, and the hub picks
up pull requests every five minutes and a policy file change within a few
minutes. For live events, forward webhooks with a tunnel
([Webhooks on localhost](DEV.md#webhooks-on-localhost-unverified)).

A real deployment also needs:

- Postgres 15+.
- One machine or container for the hub, built from the root `Dockerfile`, with
  a persistent volume for `HUB_DATA_DIR` and a public HTTPS domain GitHub can
  reach. The hub serves the portal, the API and the webhooks (`/api/hooks/...`)
  on that one domain.

Optional, locally or deployed: a Google OAuth client for sign-in, an SMTP
account for invite emails, and for [code review](PRODUCT.md#code-review) an
Anthropic key and an [isolated place to run it](#where-sidecars-run).

Size the hub for its sidecars: each deployment Triage runs on the hub's
machine (the listener for each host, each manager and the judge) runs in a
sidecar process of its own, up to `TRIAGE_MAX_LOCAL_SIDECARS` at once. Each
takes about 0.5 GB, and one starts only while 1 GiB is free beside those still
connecting.

## Run it

### Migrations

The image has two commands: `bun run db:migrate`, which applies the database
migrations to `DATABASE_URL`, and the hub's normal start. The hub never
migrates on start and refuses to start until the database is migrated, so
run `bun run db:migrate` once before starting or
upgrading the hub: as the host's pre-deploy or release step, or as a one-off
run of the same image with the same `DATABASE_URL`.

### Docker Compose

`compose.yml` runs Postgres, a `migrate` service for the
[migrations](#migrations), and then the hub at `http://localhost:3000`. In `.env`
set only the four secrets; compose sets `DATABASE_URL`, `HUB_DATA_DIR`, `PORT`
and `BETTER_AUTH_BASE_URL`, and applies the [database role](#database-role)
setting.

```sh
cp .env.example .env   # set the four secrets: openssl rand -hex 32 each
docker compose up -d
docker compose logs hub
```

Compose builds the hub image from your checkout. The first build needs about
3 GB of free Docker disk, and with less it stops with `no space left on device`.
To update, pull the new commits and run `docker compose up -d` again.

The `migrate` service runs to completion before the hub starts. The hub is
ready when it logs `Started server: http://localhost:3000`; the portal is at
that address. A `docker_sidecars_off` line is expected: triage needs no Docker,
only code review does ([Where sidecars run](#where-sidecars-run)).

### Railway

[Railway Sandboxes](provisioners/railway-sandboxes.md) for code review need
`SANDBOX_REPOSITORY` and `SANDBOX_COMMIT_SHA` to name a public repository,
this one or your public fork, at the commit the hub runs; set them with each
deploy (step 7). With the [Railway CLI](https://docs.railway.com/cli) logged
in:

1. Create the project. With more than one Railway workspace, `railway init`
   needs `--workspace`; `railway whoami --json` lists yours:

   ```sh
   railway init --name corbits-triage --workspace <workspace>
   ```

2. Add Postgres:

   ```sh
   railway add --database postgres
   ```

3. Add an empty hub service. Run the [migrations](#migrations) as its
   Pre-deploy Command (Settings → Deploy): `bun run db:migrate`.

   ```sh
   railway add --service hub
   ```

4. Generate its domain on port 3000. It prints the `https://…up.railway.app`
   address near the top; `BETTER_AUTH_BASE_URL` is that address.

   ```sh
   railway domain --service hub --port 3000
   ```

5. Set the variables. Each of the four secrets is a different
   `openssl rand -hex 32`.

   ```sh
   railway variable set --service hub \
     BETTER_AUTH_SECRET=<hex> CREDENTIAL_ENCRYPTION_KEY=<hex> \
     PRINCIPAL_KEY_ENCRYPTION_KEY=<hex> SIDECAR_CREDENTIAL_ENCRYPTION_KEY=<hex> \
     'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
     BETTER_AUTH_BASE_URL=https://<domain from step 4> \
     HUB_DATA_DIR=/data PORT=3000 RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
   ```

6. Add a volume at `/data`:

   ```sh
   railway service hub
   railway volume add --mount-path /data
   ```

7. Deploy from a clean checkout of the commit you want to run. The commit must
   already be pushed to the public repository, this one or your public fork,
   because the Railway sidecar template fetches it from GitHub. Set the
   repository and commit variables and deploy; repeat both with each deploy.

   ```sh
   railway variable set --service hub --skip-deploys \
     SANDBOX_REPOSITORY=<owner>/<name> SANDBOX_COMMIT_SHA=$(git rev-parse HEAD)
   railway up --service hub
   ```

8. Set the [database role](#database-role) setting, then redeploy the hub
   (`railway redeploy --service hub --yes`).

The hub is ready when its deploy logs show `Started server`.

### Render

A Postgres instance and one Docker web service from this repository, with a
disk at `/data`. Variables as on Railway, without
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and the [migrations](#migrations) as
the pre-deploy command. Railway Sandboxes need `SANDBOX_REPOSITORY` and
`SANDBOX_COMMIT_SHA` set with each deploy, as on Railway.

### Any other host

1. Provision Postgres. Add `?sslmode=require` to its URL when it is reached
   over the public internet.
2. Set the [required variables](#required) and any optional ones.
3. Run the [migrations](#migrations) before each start or upgrade.
4. Give the platform a drain time longer than `HUB_SIDECAR_STOP_TIMEOUT_MS`
   (default 25 seconds), the most a local sidecar takes to stop.
5. Terminate TLS in front of the hub.

Sign-in and email rate limits count each caller by address. On Railway the
hub is detected and reads the address from the header Railway's proxy sets,
and each session records that address; there is nothing to configure. Anywhere
else the hub logs `auth_client_ip_unresolved` at start-up: the limits are
shared unless a proxy sets `X-Forwarded-For` to exactly the caller's address,
so one person's failed attempts can briefly block another's.

### Database role

On every Postgres but Compose's, set this on the hub's database role: it ends
wedged transactions after ten minutes, so a stuck run-log receive releases its
lock and the sidecar pushes again:

```sql
alter role <hub role> set idle_in_transaction_session_timeout = '10min';
```

Railway's Postgres has no public address by default, so run it from inside
the Postgres service; its role is `postgres`:

```sh
railway ssh --service Postgres "psql \"\$DATABASE_URL\" -c \"alter role postgres set idle_in_transaction_session_timeout = '10min';\""
```

## Set up in the portal

1. **Sign up.** The first sign-in creates your workspace.
2. **Create the GitHub App** with **Create GitHub App** and confirm the
   prefilled form on GitHub. The private key goes to the hub's vault and never
   reaches the browser or the workflows. The App's webhook URL is built from
   `BETTER_AUTH_BASE_URL`, so set that to the public URL before starting. When
   it is on localhost the App is created without a webhook and the hub polls
   instead ([What you need](#what-you-need)).

   To reuse an App, expand **Connect an existing GitHub App instead**, enter its
   App ID, private key and webhook secret, and set its webhook URL to the one
   shown (on localhost, leave the App's webhook inactive). GitHub must accept
   the App ID and key. A workspace uses the App on one account; install it on
   one account only. It needs:

   - Permissions: Pull requests, Issues and Contents: write; Checks, Members
     and Metadata: read.
   - Events: Pull request, Pull request review, Issue comment, Check run,
     Check suite and Push. GitHub sends installation events to every App
     without ticking them.

   Bitbucket Data Center connects with an access token instead; see
   [BITBUCKET_DATACENTER.md](BITBUCKET_DATACENTER.md).
3. **Choose repositories on GitHub.** They arrive with triage off. Press **Open Repositories** to leave setup. Nothing runs yet.
4. **Add a policy file.** A repository's rules and actions come only from
   `.corbits-triage.yml` on its default branch ([Policy file](PRODUCT.md#policy-file)).
   A repository without one offers **Start a policy file**: **Create pull
   request** and merge it.
5. **Turn on triage.** Open the repository under Repositories and turn on
   **Triage pull requests in this repository**. When the policy has judgement rules and no model is saved,
   the repository says it needs a model. Add the model on the Code review
   page: pick TypeSafe, Vercel AI Gateway or OpenCode Zen and paste an API
   key, or **Add my own provider** with a System One–compatible base URL
   (requests go to it + `/systemone`), model and key. Saving it makes the hub
   publish and start the triage workflows; triage is live once that
   finishes. Open pull requests are triaged, then every new pull request
   event. Verdicts appear on Triage.

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
password. Every account but the hub's first must verify its address before it
can use the portal or the API: with email set up, sign-up sends a link to open;
without it, Google accounts are verified, and the hub's first account can mark
anyone in its workspace, member or invited, verified under **Settings → People**.

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enable "Continue with Google". Set both or neither. Create a Google Cloud OAuth client (Web application) with redirect URI `<BETTER_AUTH_BASE_URL>/api/auth/callback/google`. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact emails and `@domains`, for example `@example.com,friend@example.org`. Admits only verified addresses, the first account included. Without email set up it requires Google and turns email/password sign-in off; with email, email/password sign-ups in it verify their address first. Checked at every sign-in, so existing accounts outside it are locked out, and invites outside it are refused. |

### Email

Admins invite teammates from the portal. Someone who signs in without an
invitation gets a workspace of their own; an invitation later adds the
inviting workspace to theirs. With email set up, the invitee gets a one-time
sign-in link that works once, expires after 15 minutes and can be resent. With email
set up, an account whose address is not verified (an email and password
sign-up) cannot be invited. With email set up, anyone can also reset their password from the
sign-in page, and an email and password sign-up is sent a link to verify its
address, valid for an hour. Until it opens the link it sees only **Verify your
email**, with **Resend link** (once a minute) and **Sign out**. Existing
unverified accounts see the same screen once email is set up.
With email set up, a workspace's owners and admins are also emailed when its
pull requests stop reaching Triage, and again once they reach it
(`TRIAGE_STALLED_AFTER_MS` under [Triage tuning](#triage-tuning)).

| Variable | Value |
| --- | --- |
| `SMTP_URL` | Any SMTP provider, credentials in the URL: `smtps://user:password@smtp.example.com:465`, or `smtp://` to upgrade with STARTTLS when offered. Percent-encode special characters in the password. |
| `EMAIL_FROM` | The sender, for example `Triage <triage@example.com>`, on a domain the provider accepts. |

Set both or neither. Without them only people who have already signed in can be
invited, and the portal shows each invite link to copy and send yourself.
An email and password account other than the first then sees **Verify your
email**, asking whoever runs the hub to verify it, until the hub's first
account invites it to its workspace and presses **Mark verified** beside it
under **Settings → People**. Do that only for an address you know is theirs.

### Portal hosting

| Variable | Value |
| --- | --- |
| `PORTAL_DIR` | Directory of the built portal the hub serves, and whose bundled workflows it publishes to every workspace. The image sets it. |
| `PORTAL_ORIGIN` | The portal's origin when it is [hosted apart from the hub](#portal-hosted-separately) under the same parent domain. The hub allows exactly that origin with credentials, and invite links point there. |

### Triage tuning

All optional; the defaults suit most installs.

| Variable | Default | Effect |
| --- | --- | --- |
| `TRIAGE_RECONCILE_INTERVAL_MS` | 300000 | How often the hub re-queues open pull requests whose latest commit has no verdict. |
| `TRIAGE_RECONCILE_RETRY_MS` | 15000 | How soon a pass that could not reach a host's listener tries again, doubling up to two minutes. |
| `TRIAGE_MANAGER_READY_MS` | 120000 | How long Triage waits for a pull request's just-started manager to come up before it starts another in its place. |
| `TRIAGE_MANAGER_START_GRACE_MS` | 120000 | How long a just-started manager may take to come up and still keep its pull request. |
| `TRIAGE_MANAGER_POLL_MS` | 30000 | How often a pull request's manager checks again while it waits for CI, the decision model or code review. |
| `TRIAGE_WAKE_POLL_MS` | 2000 | How often Triage checks whether a just-started manager has come up. |
| `TRIAGE_MAX_IN_FLIGHT` | 5 | Pull request heads a workspace may have queued or running at once. |
| `TRIAGE_CAPPED_RETRY_MS` | 21600000 | How long a head that ran out of attempts waits before a fresh set. |
| `TRIAGE_STALLED_AFTER_MS` | 300000 | How long a pull request may wait for Triage to start before the hub raises the alarm for its host in that workspace: the `triage_stalled` log line, a notice in the portal, and, with [email](#email) set up, one email to the workspace's owners and admins; `triage_stall_cleared` and a second email follow once Triage starts a pull request on that host again. The alarm fires within this time plus one `TRIAGE_LIVENESS_INTERVAL_MS`. |
| `TRIAGE_LIVENESS_INTERVAL_MS` | 60000 | How often the hub checks each workspace for pull requests waiting past `TRIAGE_STALLED_AFTER_MS`. |
| `TRIAGE_COALESCE_QUIET_MS` | 30000 | Quiet time before a pull request's webhook events go out as one run, at most four times this after the first. A new commit, an opened, reopened or ready pull request, an approval or a change request waits only 3 seconds. Must stay below 150000. |

### Hub and sidecars

| Variable | Default | Effect |
| --- | --- | --- |
| `HUB_SIDECAR_STOP_TIMEOUT_MS` | 25000 | How long a local sidecar gets to finish writing run state after SIGTERM before SIGKILL. |
| `TRIAGE_MAX_LOCAL_SIDECARS` | 8 | Sidecar processes the hub runs on its own machine at once, one per deployment or probe: the listener for each host, one manager per pull request being triaged, and the judge. |
| `HUB_API_ORIGIN` | the origin of `BETTER_AUTH_BASE_URL` | The origin sidecars reach the hub REST API at, for workflows that call it. An `http` or `https` origin with no path. Set it when sidecars run in Docker on the hub's machine, where `localhost` is the container. |
| `HUB_SIDECAR_WEBSOCKET_URL` | `ws://127.0.0.1:<PORT>/api/sidecars/ws` | The address sidecars dial. Leave it unset for Docker [on another machine](provisioners/docker-remote.md), whose sidecars dial `BETTER_AUTH_BASE_URL` over `wss://`. |
| `DOCKER_HOST` | the docker CLI's context, else its default sockets | The daemon for the [Docker provisioner](provisioners/docker.md). |
| `DOCKER_CONTEXT` | the docker CLI's current context | The docker CLI context to use when `DOCKER_HOST` is unset. |
| `DOCKER_TLS_CA` | unset | `ca.pem`, the CA that signed the daemon's certificate, as one line of base64. With `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY`, turns on mutual TLS to the daemon. Required for a daemon on another machine. |
| `DOCKER_TLS_CERT` | unset | `cert.pem`, the hub's client certificate, as one line of base64. |
| `DOCKER_TLS_KEY` | unset | `key.pem`, the client certificate's key, as one line of base64. |
| `E2B_API_KEY` | unset | Registers the [E2B provisioner](provisioners/e2b.md), which runs each isolated sidecar in an E2B sandbox. |
| `RAILWAY_SANDBOX_TOKEN`, `RAILWAY_SANDBOX_ENVIRONMENT_ID` | unset | A Railway workspace token and the environment the [Railway Sandboxes provisioner](provisioners/railway-sandboxes.md) creates sandboxes in. Set both or neither. |
| `SANDBOX_REPOSITORY`, `SANDBOX_COMMIT_SHA` | unset | The public GitHub repository (`owner/name`) and full commit hash the Railway sidecar template checks out, set with each deploy ([Railway](#railway)). Required with `RAILWAY_SANDBOX_TOKEN`; a service Railway deploys from GitHub may leave them unset, since Railway's own `RAILWAY_GIT_*` values are used then. |
| `GITHUB_API_ORIGIN` | `https://api.github.com` | GitHub API origin; for the local emulator only. |
| `BITBUCKET_EGRESS_ALLOWLIST` | unset | Comma-separated hostnames or IPs of Bitbucket Data Center instances on a private network. The hub sends a Bitbucket token only to public addresses, plus private or loopback addresses of a host listed here. Set it before upgrading when a workspace is already connected to a private-network instance: until then that workspace's Bitbucket requests and runs are refused. Workflow runs resolve the instance in their sidecar, so on cloud hosts also deny sidecar egress to metadata addresses (`169.254.0.0/16`, `fd00:ec2::254`, `100.100.100.200`) at the network layer. See [BITBUCKET_DATACENTER.md](BITBUCKET_DATACENTER.md). |
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
| `HUB_SIDECAR_REQUEST_TIMEOUT_MS` | 30000 |
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

The hub still publishes the workflows bundled in its own image's
`PORTAL_DIR`, so deploy the hub and the portal from the same commit.

## Where sidecars run

Triage runs in sidecars that are child processes on the hub's machine, one
per deployment; it needs nothing more. Code review needs a sidecar of its own, so it runs only once an
isolated place is set up.
The Code review page's **Where it runs** lists every place this server
offers, with the `.env` lines and guide for each; code review uses the first
ready one in the order shown and waits there when it is full.
[provisioners/README.md](provisioners/README.md) covers each option.

For Docker, the hub needs the sidecar image built before it starts
([Docker](provisioners/docker.md#set-up)).
The stock `compose.yml` mounts no Docker socket. For code review on the same
machine's Docker under Compose, start it with `compose.docker.yml` as well:

```sh
docker compose -f compose.yml -f compose.docker.yml up -d
```

That builds the sidecar image from the same checkout before the hub starts,
and mounts the Docker socket into the hub. The hub then controls that
machine's Docker, which on Linux is root on the machine: whoever takes over
the hub takes over the machine. For a socket elsewhere, such as rootless
Docker's or Podman's, set `DOCKER_SOCKET` in `.env` to its path. Pass the
same `-f` flags to later `docker compose` commands. The Code review page's **Where it runs**
then shows **Docker on this machine** ready. Or set `DOCKER_HOST` in `.env` to
[another machine](provisioners/docker-remote.md).

## Backups

- **Postgres**: workspaces, accounts, the vault, deployments and verdicts.
- **The `HUB_DATA_DIR` volume**: run history, workflow sources and sidecar
  state.
- **The four keys.** Store them apart from the database: a restored database
  without the same keys has an unreadable vault.

## Upgrading

Pull the new version, rebuild the image, run the [migrations](#migrations)
and redeploy; the hub does not start until they have run. On Railway, repeat
[step 7](#railway) so the commit variables name the version you deploy. As it
starts, the hub publishes the build's workflows and rolls every workspace onto
them, at most two workspaces at a time; Settings → Triage shows each host's version and
any roll that failed.
- A workspace whose GitHub App is installed on more than one account must
  sync its repositories after upgrading and keep the App on one account: one
  installation token serves the workspace, so the other accounts' repositories
  are left out.

- A GitHub App created by an earlier build may lack permissions or events
  added since. Accept new permissions (Contents: write, Members: read) when
  GitHub asks an owner, and tick new events (Push, Check suite) under the App's
  settings → Permissions & events. Until then, a policy file change committed
  straight to the default branch, rather than merged in a pull request, is
  read only after a hub restart, and a pull request waiting for CI is triaged after
  the quiet time instead of seconds after CI finishes.
- Rules saved in the portal by an earlier build are archived on the first
  start of this one and no longer run: a repository runs on its
  `.corbits-triage.yml` only. Before upgrading, move any you still need into
  that file on an earlier build, or write the file again afterwards.
- What Triage does on its own can now follow each policy file, but an
  existing workspace keeps asking: the first start of this build sets it to
  ask, so **Take the actions each policy file names without asking** is off,
  only the verdict is posted on its own, and actions allowed by hand stay
  allowed. Once an owner or admin turns it on under Settings → Triage, Triage
  takes every action its enabled repositories' files name within one
  reconcile pass, and stops taking actions allowed by hand that a file does
  not name. A workspace created after the upgrade starts with it on.
- Earlier builds left tables the hub no longer uses; drop them if present:
  `DROP TABLE IF EXISTS corbits_triage_tenant_migration, corbits_triage_verdict_backfill, corbits_github_manifest_state;`
- `bun run db:migrate` drops `corbits_triage.invitation`; invites still open then
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
- A code review requested while the listener is starting or being replaced
  answers `503 service_not_running`; retry it once the listener is up.
