# @corbits/bitbucket-datacenter-tool

The Bitbucket Data Center sidecar tools for Interchange: `bitbucketRead` (`bitbucket_datacenter_*` reads) and
`bitbucketWrite` (the mirror and actions), both on the `bitbucket-datacenter` credential, and `checkout`, which unpacks
a repository at a commit into a folder. The portal
packs it beside the workflows it deploys; the hub and the workflow packages import its tools and action logic.

## Use

```ts
import { bitbucketRead, bitbucketWrite, executeAction, parseActionInput } from "@corbits/bitbucket-datacenter-tool";
```

`/bitbucket` holds the write helpers and `/action` the action logic. `bitbucket_datacenter_mirror` asks for approval;
the `_auto` writes do not.

```sh
bun run build      # bundle to dist/index.js
bun run pack:tool  # bundle and pack the tool tarball; prints its path and integrity
```

## Test

```sh
bun --conditions=intx-src test packages/bitbucket-datacenter-tool
```

## Docs

- [BITBUCKET_DATACENTER.md](../../docs/BITBUCKET_DATACENTER.md)
- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
