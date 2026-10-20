# @corbits/provisioner-test

The conformance suite for sidecar provisioners. It checks an Interchange `SidecarProvisioner` against its backend: ensure, destroy, generations and declared capabilities.

## Use

```ts
import { describeProvisionerConformance } from "@corbits/provisioner-test";

describeProvisionerConformance("my-backend", async () => ({ provisioner, live, capabilityChecks, dispose }));
```

## Test

`bun --conditions=intx-src test packages/provisioner-<name>` runs it with that provisioner's tests. Live check: see [e2e/README.md](../../e2e/README.md).

See [writing-your-own.md](../../docs/provisioners/writing-your-own.md) for what each field must do.
