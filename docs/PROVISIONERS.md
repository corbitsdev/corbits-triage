# Writing a sidecar provisioner

A provisioner starts and stops sidecars on one backend: a process, a container, a cloud sandbox. Each is an Interchange `SidecarProvisioner` (from `@intx/hub-sessions`). The hub decides when to ensure or destroy, and counts a sidecar as ready only when it connects; the provisioner only creates and removes infrastructure.

## Start from the template

Copy `packages/provisioner-template`. `src/index.ts` is a complete provisioner; `src/backend.ts` stands in for your backend's SDK. Replace the `backend` calls with your SDK and keep the rest:

- **`id`** names the provisioner. **`bindingFingerprint`** is a stable, non-secret identity of the backend configuration, such as `docker:v1:<daemon host>`. Change it when the configuration points somewhere else, so the hub never cleans up old sidecars through the new backend.
- **`capabilities`** declares what every sidecar it starts guarantees, such as `isolation:workload`. Workflows and tenants require or block capabilities; one you do not declare never matches.
- **`ensure`** starts a sidecar for `allocationId`, `generation` and `sidecarId`, with `token` and `hubWebSocketUrl` in its environment. Label the resource with those three values so it can be found again, and never put the token in a label. Repeating an ensure returns the same sidecar. Reject a generation older than one already seen. Throw when you cannot tell whether a sidecar was created; a rejection tells the hub nothing exists.
- **`destroy`** removes the allocation's sidecars at `generation` or older. At that same generation it removes only `sidecarId`: on replacement the hub destroys the old sidecar at generation N+1, then ensures a new `sidecarId` at N+1, and a delayed destroy must not remove the new one. Find resources by their labels; `externalRef` is a shortcut the hub may never have recorded. Answer `cleanup: "confirmed"` only once removal is confirmed, and throw to be retried.
- After a destroy, a late ensure for the destroyed sidecar creates nothing. Serialise calls per allocation so an ensure the hub stopped waiting for finishes before the destroy that follows it.

## Prove it with the conformance suite

`@corbits/provisioner-conformance` checks the contract above against a real backend. Call it from a test file with a fresh provisioner per test and a way to read what the backend holds:

```ts
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";

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

`packages/provisioner-template/src/index.test.ts` and `apps/hub/src/sidecar/local-provisioner.conformance.test.ts` run it against the template and the hub's local-process provisioner.

## Register it

The hub registers provisioners in `apps/hub/src/server.ts`, in `sidecarProvisioners` for deployments and `probeSidecarProvisioners` for probes; in each list the first match wins. Pass the same instance to both, so a deployment can adopt its probe's sidecar. Configuration comes from `apps/hub/src/env.ts` only.
