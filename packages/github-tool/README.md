# @corbits/github-tool

The GitHub sidecar tools for Interchange: `githubRead` (`github_*` reads) and `githubWrite` (the mirror, actions and
other writes), both on the `github` credential, and `checkout`, which unpacks a repository at a commit. The portal
packs it beside the workflows it deploys; the hub and the workflow packages import its tools and action logic.

## Use

```ts
import { githubRead, githubWrite, executeDo, parseDoInput } from "@corbits/github-tool";
```

`/github` holds the write helpers and `/do` the action logic. Writes other than `github_mirror_auto` and
`github_execute_do_auto` ask for approval.

```sh
bun run build      # bundle to dist/index.js
bun run pack:tool  # bundle and pack the tool tarball; prints its path and integrity
```

## Test

```sh
bun --conditions=intx-src test packages/github-tool
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
