# @corbits/repo-read-tool

Read-only sidecar tools confined to a repository checkout: `read_file`, `grep` and `list`, refusing any root outside
`<SIDECAR_DATA_DIR>/checkouts` and any `..`, absolute path or symlink out of it. The host tool packages and
`@corbits/pr-code-review` use it.

## Use

```ts
import { repoRead, REPO_READ_DEFINITIONS, linesOf, MAX_LINES } from "@corbits/repo-read-tool";
```

`repoRead` is the tool and `repoReadUnder` builds it over another data dir; `sidecarDataDir` and
`checkoutsUnder` name where checkouts live. The host packages reuse `checkTarget`, `cachedLoads`, `linesOf` and
`unpackArchive` (which fails past 500 MB packed or unpacked) for their `checkout` and `*_read_file`.

## Test

```sh
bun --conditions=intx-src test packages/repo-read-tool
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#code-review-pipeline)
