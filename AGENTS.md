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

## Interchange reference

Before writing anything that touches the hub, sidecars or workflows, check these for a stock route or primitive first. Links pin the stock ref in `vendor/interchange/VENDORED.md`; update them when the pin bumps.

- [LAYOUT.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/LAYOUT.md), [CONVENTIONS.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/CONVENTIONS.md): where things live and how upstream writes code
- [ARCHITECTURE.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/ARCHITECTURE.md): hub, sidecar and workflow run model
- [WORKFLOW_AUTHORING.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/WORKFLOW_AUTHORING.md): how workflows are written
- [workflow-lifecycle-policy.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/workflow-lifecycle-policy.md), [SIDECAR_PLACEMENT.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/SIDECAR_PLACEMENT.md): lifetimes, capacity release and where sidecars run
- [API.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/API.md), [ROUTES.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/ROUTES.md): the stock routes the portal and hub use
- [INBOUND_MAIL_POLICY.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/INBOUND_MAIL_POLICY.md), [MESSAGE.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/MESSAGE.md): mail routing behind the webhook bridge
- [AUTH.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/AUTH.md), [CREDENTIALS.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/CREDENTIALS.md), [GIT_ACCESS.md](https://github.com/faremeter/interchange/blob/779b47f59c47026b14f02eb54eefa90e15b7fd9a/docs/GIT_ACCESS.md): sessions, the vault and git tokens

## Coding Preferences

- Match existing style. No license headers in source files; LICENSE.md is the license.
- Comments say why something was done when that is not clear from the code, concisely. Otherwise no comment; the code documents itself.
- async/await with try/catch; no `.then`/`.catch`/`.finally` chains.
- Named functions; no IIFEs or anonymous callbacks beyond one-line array methods.
- No dynamic imports, except in the portal for bundle splitting.
- Fallbacks only where a real default value exists. Otherwise throw, and handle errors and missing values properly.
- Tests: only load-bearing ones, end-to-end where possible. Never read `process.env` in tests.
