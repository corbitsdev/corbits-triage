# @corbits/provisioner-railway

An Interchange sidecar provisioner that runs each sidecar in a Railway sandbox of its own, built on
[`@corbits/provisioner-template`](../provisioner-template/README.md). The hub registers it.

## Use

```ts
import { connectRailwaySandboxes, createRailwaySidecarProvisioner, sweepRailwaySidecars, RAILWAY_PLACE } from "@corbits/provisioner-railway";
```

## Test

```sh
bun --conditions=intx-src test packages/provisioner-railway
```

Live check: see `e2e/README.md`.

## Docs

- [railway-sandboxes.md](../../docs/provisioners/railway-sandboxes.md)
- [Where sidecars run](../../docs/provisioners/README.md)
