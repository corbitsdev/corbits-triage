# Fly provisioner

`packages/provisioner-fly` runs each sidecar as a [Fly Machine](https://fly.io/docs/machines/) of its own, a Firecracker microVM started from the sidecar image, and declares `isolation:workload` and `network:outbound`. It calls the [Machines API](https://fly.io/docs/machines/api/) directly. The hub registers it after [Docker](docker.md), [E2B](e2b.md) and [Railway Sandboxes](railway-sandboxes.md) when `FLY_API_TOKEN` and `FLY_APP` are set, so it suits a hub with no Docker and no machine of your own, such as one on Railway.

## Set up

1. Create a Fly app to hold the sidecars, and a deploy token for it:

   ```sh
   fly apps create corbits-triage-sidecars
   fly tokens create deploy -a corbits-triage-sidecars
   ```

2. Push the root Dockerfile's `sidecar` stage to the app's registry as `registry.fly.io/<app>:sidecar`, from the repository root, and again after changing the code. With Docker on your machine:

   ```sh
   fly auth docker
   docker build --platform linux/amd64 --target sidecar -t registry.fly.io/corbits-triage-sidecars:sidecar .
   docker push registry.fly.io/corbits-triage-sidecars:sidecar
   ```

   Without Docker, Fly's remote builder does the same:

   ```sh
   fly deploy --build-only --push --dockerfile Dockerfile --build-target sidecar --image-label sidecar -a corbits-triage-sidecars
   ```

3. Give the hub a public `https://` address in `BETTER_AUTH_BASE_URL`: machines dial it as `wss://…/api/sidecars/ws`, or `HUB_SIDECAR_WEBSOCKET_URL` when that is set.
4. Set `FLY_API_TOKEN` (the whole token, `FlyV1 …` included) and `FLY_APP` on the hub, and `FLY_REGION` to pin a [region](https://fly.io/docs/reference/regions/) near it; unset, Fly picks one. Start the hub. With Fly registered there is no `fly_sidecars_off` line, and `fly_sidecars_swept` says how many leftover machines it destroyed.

## Machines

Each machine gets 2 shared CPUs and 2 GiB of memory, as much as a Docker sidecar may use ([measurements](docker.md#memory)), and is billed by Fly while it runs. It has no lifetime cap: code review's listener keeps its machine for as long as code review is on. A machine has no restart policy and destroys itself when its sidecar exits; the hub destroys it on release. At boot the hub destroys its machines that no allocation or probe still holds.

Fly's listing of an app's machines can lag behind them. The provisioner remembers the machines it created and the ones it destroyed, and confirms each destroy by reading the machine by id, so a repeated ensure never starts a second machine and a release is confirmed only once the machine is gone.

## What is isolated

Each sidecar has its own microVM: its own kernel, processes and filesystem, with outbound network. It holds only its own hub token and a credential key of its own. The sidecar's token and environment pass through Fly's API when the machine is created. Machines in one app share the app's private network, so keep the app for sidecars alone.

Machines are labelled through their metadata with a hub id derived from the hub's Postgres cluster, database and schema, so hubs sharing a Fly app never touch each other's machines. Pointing the hub at another app or database changes the provisioner's binding, and sidecars placed through the old one are not cleaned up through the new one.

## Not registered

With `FLY_API_TOKEN` and `FLY_APP` set, the hub logs `fly_sidecars_off` with one of these reasons:

| Reason | Fix |
| --- | --- |
| `Fly app … is on another machine, which reaches Triage only over TLS` | Set `BETTER_AUTH_BASE_URL` to the hub's `https://` address, or `HUB_SIDECAR_WEBSOCKET_URL` to a `wss://` one. |
| `Fly app … is on another machine, which cannot reach Triage at its own address` | Set `BETTER_AUTH_BASE_URL` to the hub's public address. |
| `Fly refuses FLY_API_TOKEN for the app …, or does not answer` | Check the token is for `FLY_APP` and has not expired. |
| `Code review cannot run on Fly while GITHUB_API_ORIGIN is set` | Unset `GITHUB_API_ORIGIN`: the module it generates under `HUB_DATA_DIR` is not in the image. |
| `Triage cannot read its database's identity` | Postgres refused the hub id query; the error says why. |

Only one of `FLY_API_TOKEN` and `FLY_APP` set stops the hub at boot. A missing image is not checked at boot: the first sidecar fails with Fly's error, and the deployment with it.

## Proving it live

`packages/provisioner-fly/proof/live.ts` runs the conformance suite and the sweep against real machines from the pushed image, with the token on standard input:

```sh
printf '{"token":"%s","app":"%s"}' "$FLY_API_TOKEN" "$FLY_APP" | bun --conditions=intx-src test ./packages/provisioner-fly/proof/live.ts
```
