# Sidecar drivers

A workflow says what its sidecar must guarantee; the hub places it on the first driver that offers that. Where a driver runs is the operator's choice.

## How placement works

- A workflow declares rules with `defineWorkflow({ sidecarPlacement: { capabilities: [{ capability: "isolation:workload", effect: "require" }] } })`. A workspace can add its own through the stock tenant config route.
- Each driver declares capabilities as `{ capability, state: "available" | "blocked" }`. Use stock names (`runtime:posix`, `network:outbound`, `isolation:workload`, `isolation:microvm`) and name guarantees, never vendors or locations.
- A capability a driver does not declare is unknown and fails every rule that names it. A namespace rule (`runtime:*`) needs a namespace declaration.
- Drivers are tried in registration order in `apps/hub/src/server.ts`; the first match wins. `local-process` comes first, so a workflow with no rule runs on the hub.
- When none matches, the deploy answers 409 `provisioner_no_match`, listing for each driver which capability missed.

| Driver | Available | Blocked |
| --- | --- | --- |
| `local-process` | `runtime:posix`, `network:outbound` | `isolation:*` |
| `docker` | `runtime:posix`, `network:outbound`, `isolation:workload` | `isolation:microvm` |
| `e2b` | `runtime:posix`, `network:outbound`, `isolation:workload`, `isolation:microvm` | none |

## Packages

| Package | Holds |
| --- | --- |
| `@corbits/provisioner` | The seam, `buildSidecarEnv`, `createSidecarProvisioners`, `deriveSidecarKey` |
| `@corbits/provisioner-local` | `local-process` driver and its encrypted manifests for boot restore |
| `@corbits/provisioner-docker` | `docker` driver |
| `@corbits/provisioner-e2b` | `e2b` driver (one microVM per allocation; [DEPLOY.md](DEPLOY.md#isolated-sidecars-on-e2b)) |

Any hub on Interchange registers them in a few lines:

```ts
const sidecars = createSidecarProvisioners([
  { driver: localDriver, credentialEncryptionKey: rootKey },
  { driver: dockerDriver, credentialEncryptionKey: deriveSidecarKey(rootKey, dockerDriver.id) },
], { onUsage: log });
await createHubServer({
  sidecarProvisioners: sidecars.deployment,
  sidecarProvisionerChooser: sidecars.chooser,
  probeSidecarProvisioners: sidecars.probe,
  probeSidecarProvisionerChooser: sidecars.chooser,
});
// on shutdown: await sidecars.drain();
```

## The seam

`createDriverProvisioner` in `@corbits/provisioner` implements the stock `SidecarProvisioner` contract once: per-allocation ordering, idempotent ensure, generation fencing, and destroy that works from the allocation id alone. A driver only starts, stops and finds capacity:

```ts
interface SidecarDriver {
  readonly id: string;
  readonly fingerprint: string;
  readonly capabilities: readonly SidecarCapabilityDeclaration[];
  readonly limits: { maxAllocations?: number };
  start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle>;
  stop(handle: SidecarHandle): Promise<void>;
  find(allocationId: string): Promise<SidecarHandle | null>;
  list(): Promise<readonly SidecarHandle[]>;
}
```

- `start` gets the sidecar's whole environment from `buildSidecarEnv` (`sidecar-env.ts`): the hub URL, the sidecar's id and join token, the sidecar credential key and the adapter manifest. The driver adds only what its backend needs (`SIDECAR_DATA_DIR`, Docker's proxy). Never pass the hub's own environment.
- Each driver's sidecars get their own credential key, `deriveSidecarKey(root, driver.id)` (HKDF-SHA256). Code inside a sidecar can read its key, so a key leaked from one backend never unseals another's stores. `local-process` keeps the root `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`, which its existing stores are sealed with.
- `find` and `list` read the allocation id, generation, sidecar id, tenant and start time back from the backend itself (labels, metadata), so a restarted hub finds what it started. Keep no table of your own.
- `stop` succeeds when the capacity is already gone.
- `fingerprint` is stable and non-secret. Changing it leaves allocations placed under the old value unmanaged, so change it only when the backend really is a different one.

## Limits and usage

- `limits.maxAllocations` caps a driver's running allocations. The chooser skips a matching driver that is full; when every match is full, the ensure is refused as retryable `capacity_full`. A deployment then retries with backoff until one frees up; a probe (stock) fails the deploy with 409.
- Every stop through the seam (replace, destroy, cleanup after a failed start) reports `{ driverId, tenantId, allocationId, generation, startedAt, stoppedAt, runtimeMs }` to `onUsage`; the hub logs it as `sidecar_usage`. Runtime counts from the backend's start time to the stop, whether or not the sidecar was alive. Not reported: local sidecars stopped at hub shutdown (they respawn at boot, and their runtime before a restart is lost) and older-generation leftovers a stop also removes.
- Size is per driver: one size class per registered driver (Docker: memory and CPUs). A second size is a second registration declaring its own capability.
- Wall-clock lifetime is the hub's: the stock lifecycle policy (`maxLifetime`, `capacityRetention`, per workspace or workflow) releases capacity. A driver's own cap, such as E2B's sandbox timeout, is only a backstop for a hub that died.

## Worked example: Docker

`@corbits/provisioner-docker` talks to the Docker Engine API over its socket.

1. **Image.** The root `Dockerfile`'s `sidecar` stage is the repository with dependencies installed, starting the stock sidecar:
   ```sh
   docker build --target sidecar -t corbits-triage-sidecar .
   ```
   Adapter modules the hub names by `file://` URL under the repository are rewritten to the same path under `/app`; a module outside the repository refuses the driver at boot, and so does a `GITHUB_API_ORIGIN` override, whose generated adapter entry lives only on the hub.
2. **Start.** `POST /containers/create` with the env, labels `intx.allocation`, `intx.generation`, `intx.sidecar`, `intx.tenant`, the size class and the hardening below; `PUT /containers/{id}/archive` with the secrets file; then `/start`.
3. **Find and list.** `GET /containers/json?all=true` filtered by the `intx.allocation` label (its value for `find`, where the newest generation wins).
4. **Stop.** Stop, then remove with its volumes, every container of the allocation up to that generation.
5. **Capabilities.** One container per allocation, nothing shared but the kernel: `isolation:workload` available, `isolation:microvm` blocked.
6. **Containment.** See [Docker containment](#docker-containment).
7. **Configuration.** `HUB_SIDECAR_DOCKER_SOCKET` and `HUB_SIDECAR_DOCKER_IMAGE`, optionally `HUB_SIDECAR_DOCKER_MAX_ALLOCATIONS`, `HUB_SIDECAR_DOCKER_MEMORY_MB` and `HUB_SIDECAR_DOCKER_CPUS`, read in `apps/hub/src/env.ts` (`dockerSidecarSettings`). Unset, the driver is not registered.
8. **Registration.** `apps/hub/src/server.ts` passes it to `createSidecarProvisioners` after `local-process`. Probes use the same list: a probe is matched against workspace policy only, so a workspace that requires `isolation:workload` gets its probe on Docker and the deployment adopts it.

## Docker containment

The sidecar runs workflow code, so a container gets as little of the host as Docker allows.

| Concern | What the driver does |
| --- | --- |
| Network | Sidecars sit on `intx-sidecars-<PORT>`, an internal network with no route out. Their only way out is one relay container, `intx-sidecar-relay-<PORT>` (the same image, `packages/provisioner-docker/src/relay.ts`), on that network and the default bridge. Both are named by the hub's port, so hubs sharing a Docker host do not share them. |
| Hub | The relay forwards `intx-hub:8080` to the hub's own port on the host (`host.docker.internal:$PORT`). The sidecar dials `ws://intx-hub:8080/<path>` whatever URL the hub advertises, so a public `wss://` URL for E2B does not affect Docker. |
| Internet | `HTTPS_PROXY` points at the relay's CONNECT proxy (`intx-egress:3128`), which resolves the name, refuses any loopback, private, link-local, CGNAT or multicast address (so `host.docker.internal` and every other host port), and connects to the address it checked. Plain HTTP and anything that ignores the proxy has no route. |
| Secrets | `SIDECAR_TOKEN` and the sidecar key go in `/var/lib/intx-sidecar/secrets.env`, uploaded before start and read by `bun --env-file`. `docker inspect` shows neither. |
| Privileges | User `bun`, every capability dropped, `no-new-privileges`, read-only root, `/tmp` on tmpfs, 1024 PIDs, the operator's memory and CPU size class. State lives in a per-container volume removed with the container. |

Limits that stay:

- Anyone with the Docker socket is root on the host: they can `docker exec` into a sidecar or read the volume. Hiding secrets from `inspect` keeps them out of logs, support bundles and monitoring agents, not from the host's administrators.
- The hub link inside the internal network is cleartext `ws://` (the sidecar warns once); it never leaves the Docker host.
- The relay allows HTTPS to any public address. A per-workflow allowlist is the next step (`exec:network`).
- A host service listening on the host's public address is reachable through the proxy, as it is from the internet.
- Sidecars of one hub share the internal network, so a workflow that listens on a port is reachable from other sidecars of that hub, other workspaces included. Separating them needs a network per allocation, which Docker's default address pools cap at about 30, or a host firewall; not built.
- The relay is shared by every sidecar of the hub; it holds no secret. A malformed or refused request ends only that connection. After rebuilding the image, remove `intx-sidecar-relay-<PORT>`; the next start recreates it.
- Requires Docker Engine 26 or later (a container created on two networks at once; no DNS forwarding from internal networks).

## Adding a driver

1. Add a package `packages/provisioner-<name>` whose driver is a `SidecarDriver`. Declare only what the backend enforces.
2. Read its settings in `apps/hub/src/env.ts` and add it to `createSidecarProvisioners` in `apps/hub/src/server.ts` only when they are set.
3. Prove it on a local hub: a workflow that requires one of its capabilities lands on it, its capacity disappears on cancel, and a hub restart with live capacity neither duplicates nor loses it.
