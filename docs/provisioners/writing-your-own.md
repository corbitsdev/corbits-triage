# Writing a sidecar provisioner

A provisioner starts and stops sidecars on one backend: a process, a container, a cloud sandbox. Each is an Interchange `SidecarProvisioner` (from `@intx/hub-sessions`). The hub decides when to ensure or destroy, and counts a sidecar as ready only when it connects; the provisioner only creates and removes infrastructure.

## Start from the template

Copy `packages/provisioner-template`. `src/index.ts` is a complete provisioner; `src/backend.ts` stands in for your backend's SDK. Replace the `backend` calls with your SDK and keep the rest:

- **`id`** names the provisioner. **`bindingFingerprint`** is a stable, non-secret identity of the backend configuration, such as `docker:v1:<daemon id>:<hub id>`. Change it when the configuration points somewhere else, so the hub never cleans up old sidecars through the new backend.
- **`capabilities`** declares what every sidecar it starts guarantees, such as `isolation:workload`. Workflows and tenants require or block capabilities; one you do not declare never matches.
- **`ensure`** starts a sidecar for `allocationId`, `generation` and `sidecarId`, with `token` and `hubWebSocketUrl` in its environment. Label the resource with those three values so it can be found again, and never put the token in a label. Repeating an ensure returns the same sidecar. Reject a generation older than one already seen. Throw when you cannot tell whether a sidecar was created; a rejection tells the hub nothing exists.
- **`destroy`** removes the allocation's sidecars at `generation` or older. At that same generation it removes only `sidecarId`: on replacement the hub destroys the old sidecar at generation N+1, then ensures a new `sidecarId` at N+1, and a delayed destroy must not remove the new one. Find resources by their labels; `externalRef` is a shortcut the hub may never have recorded. Answer `cleanup: "confirmed"` only once removal is confirmed, and throw to be retried.
- After a destroy, a late ensure for the destroyed sidecar creates nothing. Serialise calls per allocation so an ensure the hub stopped waiting for finishes before the destroy that follows it.

## Prove it with the conformance suite

`@corbits/provisioner-test` checks the contract above against a real backend. Call it from a test file with a fresh provisioner per test and a way to read what the backend holds:

```ts
import { describeProvisionerConformance } from "@corbits/provisioner-test";

describeProvisionerConformance("my-backend", async () => ({
  provisioner: createMyProvisioner(config),
  live: (allocationId) => listSidecarsFromTheBackend(allocationId),
  capabilityChecks: {
    "isolation:workload": (allocationId) => assertOwnSandbox(allocationId),
  },
  dispose: () => removeEverythingThisTestCreated(),
}));
```

`live` must read the backend, not the provisioner's memory. Every capability the provisioner declares available needs a check that throws when a running sidecar lacks it. The suite assumes one sidecar per allocation, so it expects `cleanup: "confirmed"` from every destroy.

`packages/provisioner-template/src/index.test.ts`, `packages/provisioner-docker/src/index.test.ts`, `packages/provisioner-railway/src/index.test.ts` and `apps/hub/src/sidecar/local-provisioner.conformance.test.ts` run it against the template, Docker, Railway Sandboxes (over a fake Railway API; [railway-sandboxes.md](railway-sandboxes.md#proving-it-against-railway) runs it against real sandboxes) and the hub's local-process provisioner. `packages/provisioner-docker` is a worked example on a real backend; [docker.md](docker.md) describes it. [README.md](README.md) explains how the hub picks among provisioners.

## Register it

The hub registers provisioners in `apps/hub/src/server.ts`, in `sidecarProvisioners` for deployments and `probeSidecarProvisioners` for probes; in each list the first match wins. Pass the same instance to both, so a deployment can adopt its probe's sidecar. Configuration comes from `apps/hub/src/env.ts` only. A provisioner in `sidecarProvisioners` that declares `isolation:workload` available is one code review can run on: `GET /api/integrations/code-review/{tenantId}/place` names it when it is the one selected, and the portal lets code review be switched on. Add a setup guide for it beside the others in [this folder](README.md).

To list it in Settings → Code review, export a `PlaceGuide` (from `@corbits/triage-contracts`) from your package, as `packages/provisioner-docker/src/places.ts` does: `id`, `label`, `why` (one plain sentence on when to choose it), `env` (the `.env` lines that set it up) and `guide` (its file name in this folder). In `server.ts`, add `{ guide, found }` to the `probes` passed to `createCodeReviewPlace`, with what boot found: `undefined` when it is not configured, why it could not be registered, or what it registered.
