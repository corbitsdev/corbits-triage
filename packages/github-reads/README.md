# @corbits/github-reads

GitHub REST read helpers and the read shapes every host returns. The hub, the extension, the host tool packages and
the triage workflows use it.

## Use

Each helper takes a `GithubFetch`, a `fetch` already bound to the GitHub API and a credential:

```ts
import { getPr, getChecks, summarizeChecks, type GithubFetch } from "@corbits/github-reads";

const pr = await getPr(gh, "acme/widgets", 42);
const ci = summarizeChecks(await getChecks(gh, "acme/widgets", pr.sha));
```

## Test

```sh
bun --conditions=intx-src test packages/github-reads
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
