# @corbits/policy-check-action

A GitHub Action that checks a repository's `.corbits-triage.yml` (or `.yaml`) as the hub reads it and marks each
problem on its line. It needs no Triage account and no secrets.

## Use

```yaml
on:
  pull_request:
    paths: [".corbits-triage.yml", ".corbits-triage.yaml"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: corbitsdev/corbits-triage/packages/policy-check-action@main
```

Locally, from here: `bun src/main.ts <repository root> <owner/name>`.

## Test

```sh
bun --conditions=intx-src test packages/policy-check-action
```

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md)
- [PRODUCT.md](../../docs/PRODUCT.md#policy-file)
