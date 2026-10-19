# @corbits/provisioner-e2b

An Interchange sidecar provisioner that runs each sidecar in its own E2B sandbox. The hub registers it when
`E2B_API_KEY` is set.

## Use

```ts
import { connectE2b, createE2bSidecarProvisioner, tendE2bSidecars, E2B_PLACE, E2B_SIDECAR_TEMPLATE } from "@corbits/provisioner-e2b";
```

Build the `corbits-triage-sidecar` template from the repository root, with `E2B_API_KEY` set:

```sh
bun packages/provisioner-e2b/template.ts
```

## Test

```sh
bun --conditions=intx-src test packages/provisioner-e2b
```

Live check: see [e2e/README.md](../../e2e/README.md).

## Docs

- [e2b.md](../../docs/provisioners/e2b.md)
- [Where sidecars run](../../docs/provisioners/README.md)
