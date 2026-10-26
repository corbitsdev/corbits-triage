# Where sidecars run

Every triage run, code review and workflow probe runs in a sidecar: a process that connects to the hub over a websocket and runs the workflow. A provisioner starts and stops sidecars on one backend. The hub registers each provisioner it can use and places every sidecar on one of them.

| Provisioner | Runs sidecars | Isolation | Registered |
| --- | --- | --- | --- |
| [Local process](local.md) | as child processes of the hub | none: they share the hub's machine, user and files | always |
| [Docker](docker.md) | each in a container of its own, on the hub's machine or [another one over TLS](docker-remote.md) | `isolation:workload` | when a Docker daemon with the sidecar image answers |
| [E2B](e2b.md) | each in a sandbox (microVM) of its own in E2B's cloud | `isolation:workload` | when `E2B_API_KEY` is set and E2B answers |
| [Railway Sandboxes](railway-sandboxes.md) | each in a Railway sandbox of its own | `isolation:workload` | when `RAILWAY_SANDBOX_TOKEN` and `RAILWAY_SANDBOX_ENVIRONMENT_ID` are set |

## How the hub picks one

Workflows and tenants state the capabilities a sidecar needs, such as `isolation:workload`; provisioners declare the capabilities they offer. The hub tries provisioners in the order it registered them (local process, Docker, E2B, then Railway Sandboxes) and takes the first whose capabilities satisfy every rule. A workflow with no rule therefore runs on the local process provisioner. When no provisioner matches, the deployment fails with `provisioner_no_match` and names what each provisioner lacked.

Code review requires `isolation:workload`, so it never runs on the hub's own machine. When several places are ready, it uses the first one registered (Docker, E2B, then Railway Sandboxes); there is no per-workspace choice, because a tenant placement rule would move every workflow, triage included. A place that is full declines the review's sidecar with `capacity_unavailable`; the hub defers the review and retries it on the same place, never the next one, since the place is chosen by capabilities alone. Settings → Code review → **Where it runs** says this in plain words and lists every place this hub knows, in that order, with why to choose it, its state (in use, ready, not set up, or failing with the reason, shown to those who may manage the workspace) and, for a place not set up or failing, the `.env` lines that set it up, with Copy, and its guide. Without a ready place, code review does not run, and the repository page links there.

With Docker, E2B or Railway Sandboxes registered, workflow probes (the hub's check of a workflow's source before it is deployed) require `isolation:workload`, so no probe runs on the hub's machine.

## Which to use

- **Local process** is the default and needs no setup. It suits a single box running only Corbits Triage's own workflows.
- **Docker** suits a box with Docker on it, when workflows that require a sidecar of their own must run, or when probes should not run on the hub's machine.
- **Docker on another machine** suits a hub on a platform without Docker, such as Railway: code review runs on a VPS you set up with [Docker on another machine](docker-remote.md).
- **E2B** suits a hub on a platform without Docker that should not depend on a machine of your own: each sidecar runs in E2B's cloud, billed by E2B. Setting `E2B_API_KEY`, building its template and giving the hub a public `https://` address is all it takes ([E2B](e2b.md)).
- **Railway Sandboxes** suits a hub on Railway with no machine of your own to run: code review runs in [Railway sandboxes](railway-sandboxes.md), billed by Railway.

To add a backend, see [Writing your own](writing-your-own.md).
