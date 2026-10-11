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

## How triage is built

- The pack artifact drives everything. A repository's checks, roles and actions live in its pack, stored through the stock tenant artifact route. The workflow reads the pack and derives what to check and what to do; nothing repository-specific is written into workflow code.
- The workflow is deterministic. pr-triage is stock primitives: `onTrigger` for mail, `action` for every deterministic step (facts, rule checks, evaluation, execution, dispatch), `loop` or `childWorkflow` for repetition. An agent exists only where inference happens, which is the judge step for decision-model checks. Never wrap a deterministic step in `defineAgent`.
- Every external effect is an `action` effect: through `ctx.perform`, under a declared capability that becomes an `effect:<cap>` grant, idempotent under its effect id. GitHub writes included.
- Downstream work is another workflow. Reviewing, fixing or de-slopping a pull request is a workflow of its own, started by mail or a signal from a Do. It is never a step inside pr-triage.
- API first. Everything stock goes through stock routes. Every custom hub route is a Hono route described with hono-openapi and arktype, merged into `/openapi.json`. The portal and the browser extension are wrappers over those routes and must not be the only way to do anything.
- Credentials, grants and tenants are Interchange's. Secrets live in the hub vault and are delivered to sidecars at launch and rotation; never read them anywhere else, never persist them. Where stock lacks a path (an action reaching a bound credential), raise it upstream; a vendored carry needs owner approval and the allowlist.
- Checks say how they are evaluated: rule (GitHub data, no inference), decision model (a fixed question shape that cites evidence), or agent. Actions are When → Checks → Yes / No / Unsure → Dos, each Do with its own automatic flag.

## Interchange reference

Before writing anything that touches the hub, sidecars or workflows, check these for a stock route or primitive first. Links follow upstream main; the commit we actually run is the stock ref in `vendor/interchange/VENDORED.md`.

- [LAYOUT.md](https://github.com/faremeter/interchange/blob/main/LAYOUT.md), [CONVENTIONS.md](https://github.com/faremeter/interchange/blob/main/CONVENTIONS.md): where things live and how upstream writes code
- [ARCHITECTURE.md](https://github.com/faremeter/interchange/blob/main/docs/ARCHITECTURE.md): hub, sidecar and workflow run model
- [WORKFLOW_AUTHORING.md](https://github.com/faremeter/interchange/blob/main/docs/WORKFLOW_AUTHORING.md): how workflows are written
- [workflow-lifecycle-policy.md](https://github.com/faremeter/interchange/blob/main/docs/workflow-lifecycle-policy.md), [SIDECAR_PLACEMENT.md](https://github.com/faremeter/interchange/blob/main/docs/SIDECAR_PLACEMENT.md): lifetimes, capacity release and where sidecars run
- [API.md](https://github.com/faremeter/interchange/blob/main/docs/API.md), [ROUTES.md](https://github.com/faremeter/interchange/blob/main/docs/ROUTES.md): the stock routes the portal and hub use
- [INBOUND_MAIL_POLICY.md](https://github.com/faremeter/interchange/blob/main/docs/INBOUND_MAIL_POLICY.md), [MESSAGE.md](https://github.com/faremeter/interchange/blob/main/docs/MESSAGE.md): mail routing behind the webhook bridge
- [AUTH.md](https://github.com/faremeter/interchange/blob/main/docs/AUTH.md), [CREDENTIALS.md](https://github.com/faremeter/interchange/blob/main/docs/CREDENTIALS.md), [GIT_ACCESS.md](https://github.com/faremeter/interchange/blob/main/docs/GIT_ACCESS.md): sessions, the vault and git tokens

## Coding Preferences

- Match existing style. No license headers in source files; LICENSE.md is the license.
- Comments say why something was done when that is not clear from the code, concisely. Otherwise no comment; the code documents itself.
- async/await with try/catch; no `.then`/`.catch`/`.finally` chains.
- Named functions; no IIFEs or anonymous callbacks beyond one-line array methods.
- No dynamic imports, except in the portal for bundle splitting.
- Fallbacks only where a real default value exists. Otherwise throw, and handle errors and missing values properly.
- Tests: only load-bearing ones, end-to-end where possible. Never read `process.env` in tests.
