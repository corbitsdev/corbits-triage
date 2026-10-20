# Railway Sandboxes provisioner

`packages/provisioner-railway` runs each sidecar in a [Railway sandbox](https://docs.railway.com/sandboxes) of its own, a virtual machine Railway starts in an environment you name, and declares `isolation:workload`. The hub registers it after [Docker](docker.md) and [E2B](e2b.md), so it hosts workflows that require `isolation:workload`, such as code review, and every workflow probe, on a hub with neither. In Settings → Code review → **Where it runs** it is **Railway Sandboxes** ([How the hub picks one](README.md#how-the-hub-picks-one)).

For each sidecar the provisioner creates one sandbox from the sidecar template, then starts the stock sidecar in it as a background command. The sidecar dials the hub's public `wss://` address; the sandbox has outbound internet and no access to the environment's private network.

Two limits for now:

- **One Railway token, the operator's.** Every workspace's sidecars run on the token set on the hub; a workspace cannot bring its own Railway account.
- **It declares only `isolation:workload`.** It does not declare `isolation:microvm` or `network:outbound`, so a rule requiring either never places a sidecar here.

## Set up

You need:

- A Railway plan that lets a sandbox never idle out: Hobby or Pro. Railway's [sandbox docs](https://docs.railway.com/sandboxes) say Trial and Free cannot turn the idle timeout off, so no sidecar starts there.
- Sandboxes enabled for your Railway workspace.
- The hub reachable at a public `https://` address (`BETTER_AUTH_BASE_URL`), with `HUB_SIDECAR_WEBSOCKET_URL` unset or set to its public `wss://` address. The hub refuses to register the provisioner when sandboxes would dial plain `ws://` or the hub's own machine.
- The hub deployed from a commit of a public GitHub repository, such as this one or your public fork.

### 1. Environment

Create an environment for sandboxes only, in the hub's project or a project of its own, for example `sidecars`. Copy its id: in the Railway dashboard, from the environment's settings, or with `railway status --json` after `railway environment sidecars`.

Use it for nothing else. The hub destroys only sandboxes labelled with its own id; when its boot sweep cannot finish, it logs `railway_sidecars_sweep_gave_up` and leaves the rest to the next boot.

### 2. Token

Create a workspace token for the workspace that holds the environment (Account settings → Tokens). The hub sends it as a bearer token. It can reach every project in that workspace, so keep it in the hub's variables only.

### 3. Variables

Set on the hub, then restart it (Settings → Code review shows the first two lines, with Copy):

| Variable | Value |
| --- | --- |
| `RAILWAY_SANDBOX_TOKEN` | the workspace token |
| `RAILWAY_SANDBOX_ENVIRONMENT_ID` | the sandbox environment's id |
| `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_REPO_OWNER`, `RAILWAY_GIT_REPO_NAME` | set by Railway on a hub it deploys from GitHub; set them yourself on any other hub, to the commit it runs |

Other Railway variables, such as `RAILWAY_TOKEN` or `RAILWAY_GRAPHQL_ENDPOINT`, have no effect on the hub.

With the Railway CLI linked to the hub's project and `hub` the hub's service:

```sh
railway variable set --service hub RAILWAY_SANDBOX_TOKEN=<token> RAILWAY_SANDBOX_ENVIRONMENT_ID=<environment id>
```

### 4. Template

Nothing to do by hand: at boot the hub builds the sidecar template once per version and logs `railway_sidecar_template_built`, or `railway_sidecar_template_failed` with the reason. The template's base is Railway's standard image, which cannot be pinned by digest.

### 5. Check

Open Settings → Code review. **Railway Sandboxes** says **Ready**, or **In use** when no Docker or E2B place comes before it. If it says **Failing**, the reason under it, shown to workspace admins, says what to fix; the hub also logs it as `railway_sidecars_off`. Shortly after boot, `railway_sidecars_swept` says how many of this hub's leftover sandboxes it destroyed; the sweep runs in the background and never holds up the hub.

Turn on code review for a repository. Its sidecar's sandbox shows up in the environment:

```sh
railway sandbox list --environment sidecars
```

## What is isolated

Each sidecar has a sandbox of its own: its own machine, filesystem and processes. The sandbox's own variables hold only four labels (`CORBITS_HUB`, `CORBITS_ALLOCATION`, `CORBITS_GENERATION`, `CORBITS_SIDECAR`). The sidecar's hub token and a credential key of its own are given to the sidecar's command alone, so other commands run in the sandbox do not inherit them. A command running as the same user can still read them from `/proc`; repository code must run apart from the sidecar, in the code-running tool's own sandbox.

A sandbox lives until the hub destroys it. If the sidecar process stops, nothing restarts it: the hub notices it is gone and replaces it after `WORKFLOW_DEFAULT_MAX_DISCONNECTED` (15 minutes by default).

Pointing the hub at another environment or database changes the provisioner's binding, and sidecars placed through the old one are not cleaned up through the new one.

## Cost and limits

Railway bills a sandbox per second for the memory and CPU it uses, until it is destroyed. A code review deployment keeps one sidecar running per workspace and host. Railway caps the sandboxes running in one environment by plan. When Railway is rate limiting or failing (HTTP 429 or 5xx), the hub tries the sidecar again later. Any other refusal, such as for the token, the plan or the request, is answered `railway_refused` with Railway's message and is not retried.

## Not registered

With the variables set, the place says **Failing** with one of these reasons, also logged as `railway_sidecars_off`:

| Reason | Fix |
| --- | --- |
| `A Railway sandbox is on another machine, which reaches Triage only over TLS` | Set `BETTER_AUTH_BASE_URL` to the hub's `https://` address (leave `HUB_SIDECAR_WEBSOCKET_URL` unset, or set it to a public `wss://` one). |
| `A Railway sandbox is on another machine, which cannot reach Triage at its own address` | Set `BETTER_AUTH_BASE_URL` to the hub's public address. |
| `Code review cannot run in Railway sandboxes while GITHUB_API_ORIGIN is set` | Unset `GITHUB_API_ORIGIN`: the module it generates under `HUB_DATA_DIR` is not in the repository. |
| `Triage cannot read its database's identity` | Postgres refused the hub id query; the error says why. |

Without the variables the place says **Not set up**. The hub does not start when `RAILWAY_SANDBOX_TOKEN` and `RAILWAY_SANDBOX_ENVIRONMENT_ID` are not set together, or when the `RAILWAY_GIT_*` variables are missing.

## Proving it against Railway

The [conformance suite](writing-your-own.md) runs against real sandboxes by hand only, since it creates and destroys about ten of them. With a workspace token saved in a file readable only by you, a sandbox environment, and a commit of this repository pushed to GitHub:

```sh
bun e2e/provisioners/railway.ts --token-file ~/railway-token --environment <environment id> --commit <commit>
```

The token goes to the suite on standard input, never in a command's arguments or environment. The suite destroys every sandbox it created, and only those.
