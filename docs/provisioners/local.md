# Local process provisioner

The default provisioner, in `apps/hub/src/sidecar/local-provisioner.ts`. It needs no setup.

## What it does

It starts one sidecar per allocation as a child process of the hub, with a data directory of its own under `HUB_DATA_DIR/local-sidecars`. On restart, the hub restores the sidecars its database still holds. On shutdown, each sidecar gets `HUB_SIDECAR_STOP_TIMEOUT_MS` (default 25000) to finish writing run state after SIGTERM before SIGKILL.

## Isolation it does not give

Sidecars run on the hub's machine as the hub's user. They can read the hub's files and environment, and each other's. The provisioner declares no `isolation:workload`, so a workflow or tenant that requires it is never placed here. Use [Docker](docker.md) for those.

## Capacity

It declines a new sidecar while free memory, less 1 GiB for each sidecar still starting, is below 1 GiB. Free memory is the container's cgroup limit less its usage, reclaimable page cache counted free, else Linux's `MemAvailable`. A machine with neither, such as a macOS dev machine, never declines. There is no setting. The hub retries a declined sidecar with backoff, up to Interchange's 10 ensure attempts; after the tenth the deployment fails.

The 1 GiB was measured on a local stack (2026-10-17, macOS, GitHub emulator): four pr-triage-github workers peaked at 784 to 860 MiB RSS over a full run, and idle listeners held 471 to 653 MiB. A sidecar connects with about half its peak in use, so a burst right after can still overshoot by that much.
