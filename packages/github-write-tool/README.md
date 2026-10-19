# @corbits/github-write-tool

`githubWrite` from [`@corbits/github-tool`](../github-tool/README.md) bundled on its own, as a sidecar tool on the
`github` credential.

## Use

```sh
bun run build  # bundle to dist/sidecar-bundle.js
```

## Test

No tests of its own; `@corbits/github-tool`'s tests cover the tool:

```sh
bun --conditions=intx-src test packages/github-tool
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
