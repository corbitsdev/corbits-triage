# AGENTS.md

## Commands

- `bun install`
- `bun run dev`: hub + portal (needs `.env`, see `.env.example`)
- `bun run check`: typecheck everything
- `bun run test`: all tests (hub tests need Postgres)
- `sh tooling/vendor-diff-check.sh`: vendor drift gate

## Boundaries

- Interchange is stock. Code lives in `apps/*` and `packages/*` only.
- `vendor/interchange` changes only with owner approval, each listed in `vendor/interchange/VENDORED.md` and `tooling/vendor-diff-allowlist.txt`.
- Hub env is read only in `apps/hub/src/env.ts` and passed down as config.

## Coding Preferences

- Match existing style. No license headers in source files; LICENSE.md is the license.
- Comments say why something was done when that is not clear from the code, concisely. Otherwise no comment; the code documents itself.
- async/await with try/catch; no `.then`/`.catch`/`.finally` chains.
- Named functions; no IIFEs or anonymous callbacks beyond one-line array methods.
- No dynamic imports, except in the portal for bundle splitting.
- Fallbacks only where a real default value exists. Otherwise throw, and handle errors and missing values properly.
- Tests: only load-bearing ones, end-to-end where possible. Never read `process.env` in tests.
