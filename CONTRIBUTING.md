# Contributing

Thanks for your interest in Corbits Triage.

> **`vendor/interchange` is vendored code.** Do not open a PR that changes
> anything under `vendor/interchange` unless it adds a ledgered upstream delta.
> See [VENDORED.md](vendor/interchange/VENDORED.md) for the ledger and propose
> changes upstream at [faremeter/interchange](https://github.com/faremeter/interchange).

## Before you start

- Contributions are accepted under the terms of the
  [Contributor License Agreement](CLA.md) and the project license,
  [GPLv2 with AI Exception](LICENSE.md).
- [docs/DEV.md](docs/DEV.md) covers local setup, including the GitHub emulator.

## The short version

1. `bun run check` and `bun run test` must be green before and after your change.
2. One logical change per commit; write messages for a public audience.
3. Never commit secrets. `.env.example` is the only tracked env file.
4. Never vendor code without a ledger row and kill date in
   [VENDORED.md](vendor/interchange/VENDORED.md); `sh tooling/vendor-diff-check.sh`
   enforces it.
5. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

This document will grow as the project does.
