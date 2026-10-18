# Where sidecars run

Every triage run, code review and workflow probe runs in a sidecar: a process that connects to the hub over a websocket and runs the workflow. A provisioner starts and stops sidecars on one backend. The hub registers each provisioner it can use and places every sidecar on one of them.

| Provisioner | Runs sidecars | Isolation | Registered |
| --- | --- | --- | --- |
| [Local process](local.md) | as child processes of the hub | none: they share the hub's machine, user and files | always |
| [Docker](docker.md) | each in a container of its own, on the hub's machine or [another one over TLS](docker-remote.md) | `isolation:workload` | when a Docker daemon with the sidecar image answers |

## How the hub picks one

Workflows and tenants state the capabilities a sidecar needs, such as `isolation:workload`; provisioners declare the capabilities they offer. The hub tries provisioners in the order it registered them (local process, then Docker) and takes the first whose capabilities satisfy every rule. A workflow with no rule therefore runs on the local process provisioner. When no provisioner matches, the deployment fails with `provisioner_no_match` and names what each provisioner lacked.

Code review requires `isolation:workload`, so it runs only on Docker. Without it, code review cannot be turned on, and the portal shows how to set Docker up in place of the switch.

With Docker registered, workflow probes (the hub's check of a workflow's source before it is deployed) require `isolation:workload`, so no probe runs on the hub's machine.

## Which to use

- **Local process** is the default and needs no setup. It suits a single box running only Corbits Triage's own workflows.
- **Docker** suits a box with Docker on it, when workflows that require a sidecar of their own must run, or when probes should not run on the hub's machine.
- **Docker on another machine** suits a hub on a platform without Docker, such as Railway: code review runs on a VPS you set up with [Docker on another machine](docker-remote.md).

To add a backend, see [Writing your own](writing-your-own.md).
