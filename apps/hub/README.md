# @corbits/hub

The Corbits Triage hub: the stock Interchange hub plus Triage's composition (host webhook bridges, policy reads, custom
routes). In the image it also serves the built portal.

## Use

From the repository root, with `.env` set up as [DEV.md](../../docs/DEV.md) says:

```sh
bun run hub     # hub only; `bun run start` here does the same
bun run dev     # hub and portal
```

Every custom route is described in `/openapi.json`.

## Test

```sh
bun --conditions=intx-src test apps/hub
```

`*.postgres.test.ts` need a local Postgres ([DEV.md](../../docs/DEV.md#tests-and-typecheck)).

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- [IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md)
- [SELF_HOST.md](../../docs/SELF_HOST.md)
- [BITBUCKET_DATACENTER.md](../../docs/BITBUCKET_DATACENTER.md)
