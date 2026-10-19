# @corbits/repo-read-tool

Read-only sidecar tools confined to a step's repository checkout: `read_file`, `grep` and `list`, refusing `..`,
absolute paths and symlinks out of the working tree. The host tool packages and `@corbits/pr-code-review` use it.

## Use

```ts
import { repoRead, REPO_READ_DEFINITIONS, linesOf, MAX_LINES } from "@corbits/repo-read-tool";
```

`repoRead` is the tool; the host packages reuse `checkTarget`, `cachedLoads`, `linesOf` and `unpackArchive` for their
own `*_checkout` and `*_read_file`.

## Test

```sh
bun --conditions=intx-src test packages/repo-read-tool
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#code-review-pipeline)
