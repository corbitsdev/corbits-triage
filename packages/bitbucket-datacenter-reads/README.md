# @corbits/bitbucket-datacenter-reads

Bitbucket Data Center REST read helpers that return the [`@corbits/github-reads`](../github-reads/README.md) shapes, so
triage reads both hosts the same way. The hub and `@corbits/bitbucket-datacenter-tool` use it.

## Use

Each helper takes a `BitbucketFetch` bound to the server's REST API and a credential; a repository is `PROJECTKEY/slug`:

```ts
import { getPr, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";

const pr = await getPr(bb, "ACME/widgets", 42);
```

## Test

```sh
bun --conditions=intx-src test packages/bitbucket-datacenter-reads
```

## Docs

- [BITBUCKET_DATACENTER.md](../../docs/BITBUCKET_DATACENTER.md)
