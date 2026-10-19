# @corbits/provisioner-docker

An Interchange sidecar provisioner that runs each sidecar in its own Docker container, on this machine or a remote
daemon. The hub registers it.

## Use

```ts
import { createDockerSidecarProvisioner, sweepDockerSidecars, findDockerHost, DOCKER_PLACE } from "@corbits/provisioner-docker";
```

## Test

```sh
bun --conditions=intx-src test packages/provisioner-docker
```

The conformance tests run against the local Docker daemon and are skipped when none answers. Live check: see
`e2e/README.md`.

## Docs

- [docker.md](../../docs/provisioners/docker.md)
- [docker-remote.md](../../docs/provisioners/docker-remote.md)
- [Where sidecars run](../../docs/provisioners/README.md)
