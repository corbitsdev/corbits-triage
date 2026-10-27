# Local process provisioner

The default provisioner, in `apps/hub/src/sidecar/local-provisioner.ts`. It needs no setup.

## What it does

It runs one sidecar process, a child of the hub, that hosts every deployment placed here: the listener for each host, one manager per pull request being triaged, and the judge. The sidecar runs each deployment in a workflow child process of its own. The first deployment starts the sidecar; every later one joins it. Its state lives under `HUB_DATA_DIR/local-sidecars`: `sidecar/` is its data directory, `sidecar.json` its identity, `holds.json` the deployments it holds and `fences.json` the ended ones a late request must not bring back. A deployment that ends is removed from the sidecar, which keeps running for the life of the hub. On restart, the hub starts the sidecar again if its database still holds any of those deployments, or still waits for the sidecar to remove one that ended, and forgets the ones it no longer holds. A hub upgraded from one sidecar per deployment retires each of those sidecars on its first boot, so their deployments are placed again at once, and removes their manifests and data directories. On shutdown, the sidecar gets `HUB_SIDECAR_STOP_TIMEOUT_MS` (default 25000) to finish writing run state after SIGTERM before SIGKILL.

## Isolation it does not give

The sidecar runs on the hub's machine as the hub's user. It and its deployments' workflow processes can read the hub's files and environment, and each other's. The provisioner declares no `isolation:workload`, so a workflow or tenant that requires it is never placed here. Use [Docker](docker.md) for those.

## Capacity

The sidecar runs at most `TRIAGE_SIDECAR_MAX_DEPLOYMENTS` deployments at once (default 16, at most 1792). Interchange counts the deployments placed on it and refuses one more once they fill that; the hub's placement then sends the next deployment to the first sandbox provisioner registered ([Docker](docker.md), [E2B](e2b.md) or [Railway Sandboxes](railway-sandboxes.md)). With none registered, the deployment stays here and Interchange retries its placement with backoff until a deployment ends, up to its 10 ensure attempts; after the tenth the deployment fails. Code review probes placed here run on the same sidecar, and the hub's placement counts them toward the same cap. Settings → Triage shows how many deployments and probes the sidecar runs, how many wait for a slot, and how many overflowed. A manager or judge that sits on the sidecar five minutes without starting is ended, freeing its slot, and one waiting for a slot gives up its pull request after half an hour; the listener is exempt, since it waits for its first pull request.

Memory is checked only when the sidecar starts, which needs 1 GiB free; after that the deployment cap is what bounds it, so set `TRIAGE_SIDECAR_MAX_DEPLOYMENTS` for the machine's memory. Free memory is the container's cgroup limit less its usage, reclaimable page cache counted free, else Linux's `MemAvailable`. A machine with neither, such as a macOS dev machine, never declines. The hub retries a declined start with backoff, up to the same 10 attempts.

The 1 GiB was measured on a local stack (2026-10-17, macOS, GitHub emulator) of the replaced `pr-triage-github` workflow: four of those workers peaked at 784 to 860 MiB RSS over a full run, and idle listeners held 471 to 653 MiB.
