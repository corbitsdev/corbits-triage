# Local process provisioner

The default provisioner, in `apps/hub/src/sidecar/local-provisioner.ts`. It needs no setup.

## What it does

It runs each deployment placed here in a sidecar process of its own, a child of the hub: the listener for each host, one manager per pull request being triaged, and the judge. A workflow probe gets one too, and the deployment that adopts it keeps it. Placing a deployment starts its sidecar; ending it stops the sidecar and removes its files, so no process keeps the memory of a deployment that has ended. State lives under `HUB_DATA_DIR/local-sidecars`: `manifests/<allocation>.json` names each sidecar's identity and `<allocation>-<suffix>/` is its data directory.

A restart never starts a sidecar again. On boot the hub retires every sidecar a manifest names, so Interchange places their deployments again at once on fresh sidecars, and removes the manifests and data directories. Until boot has done that, the provisioner answers no request; a boot that cannot retire one stops and keeps the files for the next boot. A sidecar that exits on its own is retired at once the same way. On shutdown, each sidecar gets `HUB_SIDECAR_STOP_TIMEOUT_MS` (default 25000) to finish writing run state after SIGTERM before SIGKILL.

## Isolation it does not give

The sidecars run on the hub's machine as the hub's user. They and their workflow processes can read the hub's files and environment, and each other's. The provisioner declares no `isolation:workload`, so a workflow or tenant that requires it is never placed here. Use [Docker](docker.md) for those.

## Capacity

At most `TRIAGE_MAX_LOCAL_SIDECARS` sidecars run at once (default 8). The hub's placement counts them and sends the next deployment to the first sandbox provisioner registered ([Docker](docker.md), [E2B](e2b.md) or [Railway Sandboxes](railway-sandboxes.md)) once they reach it. With none registered, the deployment stays here and the provisioner refuses to start its sidecar until one ends. Interchange retries the placement with backoff (1, 2, 4, 8 and 16 seconds, then every 30) for up to 10 attempts, about two and a half minutes, then fails the deployment. The manager never ran, so the pull request gets no comment or label. Its head shows as queued until Triage marks it never started, 10 minutes after it was queued; the reconcile pass, every 5 minutes, then queues it again, and further attempts wait 5 minutes, doubling each time. A new event on the pull request tries it again sooner. A workflow probe runs here only when no sandbox provisioner is registered; with one registered, probes require `isolation:workload` and run there. Settings → Triage shows how many deployments and probes run here, how many wait for a place, and how many overflowed. A manager or judge that sits on its sidecar five minutes without starting is ended, freeing its place; the listener is exempt, since it waits for its first pull request.

A sidecar starts only while 1 GiB is free beside the sidecars started that have not connected yet, whose memory is not in use yet; a start refused for memory is retried the same way. Free memory is the container's cgroup limit less its usage, reclaimable page cache counted free, else Linux's `MemAvailable`. A machine with neither, such as a macOS dev machine, never declines, so set `TRIAGE_MAX_LOCAL_SIDECARS` for the machine's memory.

Each sidecar is a sidecar process and a workflow process. Measured on a local stack (2026-10-28, macOS, the chain test's GitHub emulator), a fresh sidecar process held 160 to 250 MB and each workflow process 85 to 340 MB, so a sidecar takes about 0.25 to 0.6 GB.
