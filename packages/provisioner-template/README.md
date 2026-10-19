# @corbits/provisioner-template

A minimal Interchange sidecar provisioner to copy for a new backend. `src/backend.ts` stands in for the backend's SDK;
`@corbits/provisioner-railway` builds on it.

## Use

```ts
import { createTemplateSidecarProvisioner, createMemoryBackend, sidecarEnv } from "@corbits/provisioner-template";

const provisioner = createTemplateSidecarProvisioner({ backend: createMemoryBackend() });
```

## Test

```sh
bun --conditions=intx-src test packages/provisioner-template
```

## Docs

- [writing-your-own.md](../../docs/provisioners/writing-your-own.md)
- [Where sidecars run](../../docs/provisioners/README.md)
