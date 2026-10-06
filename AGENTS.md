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
- Never commit `.env`, `tmp/`, `mockups/` or `.corbits/`.

## Code

- Match existing style. Keep the SPDX header on every source file.
- Comments explain a non-obvious why, never what.
- async/await with try/catch; no `.then`/`.catch`/`.finally` chains.
- Named functions; no IIFEs or anonymous callbacks beyond one-line array methods.
- No fallbacks for config or required data: fail with a clear error.
- Tests: only load-bearing ones. Never read `process.env` in tests.
