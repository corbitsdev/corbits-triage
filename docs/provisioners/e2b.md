# E2B provisioner

`packages/provisioner-e2b` runs each sidecar in an [E2B](https://e2b.dev) sandbox of its own, a microVM in E2B's cloud, and declares `isolation:workload` and `network:outbound`. The hub registers it after [Docker](docker.md) when `E2B_API_KEY` is set, so it suits a hub with no Docker, such as one on Railway. In Settings → Code review → **Where it runs** it is **E2B sandboxes** ([How the hub picks one](README.md#how-the-hub-picks-one)).

## Set up

1. Create an API key in the [E2B dashboard](https://e2b.dev/dashboard).
2. Build the E2B template `corbits-triage-sidecar` from the repository root, with `E2B_API_KEY` set in your shell, and rebuild it after changing the code:

   ```sh
   bun packages/provisioner-e2b/template.ts
   ```

   E2B builds it from the repository's files, skipping what `.dockerignore` lists, so no registry is needed. The provisioner starts the sidecar itself.

3. Give the hub a public `https://` address in `BETTER_AUTH_BASE_URL`: sandboxes dial it as `wss://…/api/sidecars/ws`, or `HUB_SIDECAR_WEBSOCKET_URL` when that is set. A hub on your laptop needs a tunnel, such as `cloudflared tunnel --url http://127.0.0.1:<PORT>`.
4. Add this line to the hub's `.env` and restart it:

   ```sh
   E2B_API_KEY=e2b_your_key
   ```

5. Open Settings → Code review. **E2B sandboxes** says **Ready**, or **In use** when no Docker place comes before it. If it says **Failing**, the reason under it, shown to workspace admins, says what to fix; the hub also logs it as `e2b_sidecars_off`. `e2b_sidecars_tended` says how many leftover sandboxes it removed.

## Lifetime

A sandbox times out an hour after it was created or last extended. Every 10 minutes, and at boot, the hub extends the sandboxes an allocation or probe still holds and kills the rest, so one a hub crash left behind is gone within the hour. Extending never runs a sandbox past [E2B's limit on continuous runtime](https://docs.e2b.dev/sandbox): one hour on the Hobby plan, 24 hours on Pro. A review ends well inside that. Code review's listener, which waits for new commits, keeps its sandbox for as long as code review is on, so E2B ends that sandbox at the limit: after an hour on Hobby, a day on Pro. Sandboxes count against your E2B team's concurrency limit; when E2B refuses one for that, the hub retries it with backoff like a full Docker host.

## What is isolated

Each sidecar has its own microVM: its own kernel, processes and filesystem, with outbound network. It holds only its own hub token and a credential key of its own. The sidecar's token and environment pass through E2B's control plane when the sandbox's command starts.

Sandboxes are labelled with a hub id derived from the hub's Postgres cluster, database and schema, so hubs sharing an E2B team never touch each other's sandboxes. Pointing the hub at another database changes the provisioner's binding, and sidecars placed through the old one are not cleaned up through the new one.

## Not registered

With `E2B_API_KEY` set, the place says **Failing** with one of these reasons, also logged as `e2b_sidecars_off`:

| Reason | Fix |
| --- | --- |
| `An E2B sandbox is on another machine, which reaches Triage only over TLS` | Set `BETTER_AUTH_BASE_URL` to the hub's `https://` address (leave `HUB_SIDECAR_WEBSOCKET_URL` unset, or set it to a public `wss://` one). |
| `An E2B sandbox is on another machine, which cannot reach Triage at its own address` | Set `BETTER_AUTH_BASE_URL` to the hub's public address. |
| `E2B refused E2B_API_KEY or did not answer` | Check the key in the E2B dashboard. |
| `Code review cannot run in E2B while GITHUB_API_ORIGIN is set` | Unset `GITHUB_API_ORIGIN`: the module it generates under `HUB_DATA_DIR` is not in the template. |
| `Triage cannot read its database's identity` | Postgres refused the hub id query; the error says why. |

A missing template is not checked at boot: the first sidecar fails with E2B's error, and the deployment with it.
