# AGENTS.md

Repository-wide rules. `apps/*` and some `packages/*` have their own AGENTS.md with the rules for that area.

## Commands

- `bun install`
- `bun run dev`: hub + portal (needs `.env`, see `.env.example` and docs/DEV.md)
- `bun run check`: typecheck the apps, tooling and packages (except `openai-null-delta`) and bundle the hub
- `bun run test`: all tests (hub tests need Postgres)
- `bun run lint`: oxlint
- `e2e/`: live checks against real services, run by hand, never in CI (e2e/README.md)
- `sh tooling/vendor-diff-check.sh`: vendor drift gate

## Boundaries

- Interchange is stock. Code lives in `apps/*` and `packages/*` only.
- `vendor/interchange` changes only with maintainer approval, each listed in `vendor/interchange/VENDORED.md` and `tooling/vendor-diff-allowlist.txt`.

## Architecture

- **Stock first.** Before writing logic, look for an Interchange route or primitive that already does it (see the reference below). Re-implementing one is a defect; where stock lacks a path, raise it upstream instead of building a copy.
- **The policy drives everything.** A repository's rules and actions live in its policy: `.corbits-triage.yml` on its default branch, or a stored policy through the stock tenant artifact route. Nothing repository-specific is written into workflow code.
- **Workflows are deterministic.** Agents exist only where inference happens ([packages/triage-workflows/AGENTS.md](packages/triage-workflows/AGENTS.md)).
- **Effects are idempotent** under their effect id, host writes included.
- **Grants decide automation.** Whether an action runs on its own is decided from the workspace's role grants, never a hard-coded limit.
- **Downstream work is another workflow.** Reviewing, fixing or cleaning up a pull request is a workflow of its own, started by mail or a signal from an action; never a step inside pr-triage.
- **API first.** Every custom hub route is described in `/openapi.json`. The portal wraps those routes and is never the only way to do anything.
- **Credentials, grants and tenants are Interchange's.** Secrets live in the hub vault and reach sidecars at launch and rotation; never read them anywhere else, never persist them.
- **Hosts.** GitHub and Bitbucket Data Center. A repository record carries `source` (absent = GitHub), every mail names it as `repoSource`, and each host has its own pr-triage package. A change to host behaviour covers both, or says why not.

## Interchange reference

Check these for a stock route or primitive before touching the hub, sidecars or workflows. Links follow upstream main; the commit we run is the stock ref in `vendor/interchange/VENDORED.md`.

- [LAYOUT.md](https://github.com/faremeter/interchange/blob/main/LAYOUT.md), [CONVENTIONS.md](https://github.com/faremeter/interchange/blob/main/CONVENTIONS.md): where things live and how upstream writes code
- [ARCHITECTURE.md](https://github.com/faremeter/interchange/blob/main/docs/ARCHITECTURE.md): hub, sidecar and workflow run model
- [WORKFLOW_AUTHORING.md](https://github.com/faremeter/interchange/blob/main/docs/WORKFLOW_AUTHORING.md): how workflows are written
- [workflow-lifecycle-policy.md](https://github.com/faremeter/interchange/blob/main/docs/workflow-lifecycle-policy.md), [SIDECAR_PLACEMENT.md](https://github.com/faremeter/interchange/blob/main/docs/SIDECAR_PLACEMENT.md): lifetimes, capacity release and where sidecars run
- [API.md](https://github.com/faremeter/interchange/blob/main/docs/API.md), [ROUTES.md](https://github.com/faremeter/interchange/blob/main/docs/ROUTES.md): the stock routes the portal and hub use
- [INBOUND_MAIL_POLICY.md](https://github.com/faremeter/interchange/blob/main/docs/INBOUND_MAIL_POLICY.md), [MESSAGE.md](https://github.com/faremeter/interchange/blob/main/docs/MESSAGE.md): mail routing behind the webhook bridge
- [AUTH.md](https://github.com/faremeter/interchange/blob/main/docs/AUTH.md), [CREDENTIALS.md](https://github.com/faremeter/interchange/blob/main/docs/CREDENTIALS.md), [GIT_ACCESS.md](https://github.com/faremeter/interchange/blob/main/docs/GIT_ACCESS.md): sessions, the vault and git tokens

## Code

- Match existing style. No license headers; LICENSE.md is the license.
- Comments say why, when the code cannot; never what it does.
- async/await with try/catch; no `.then`/`.catch`/`.finally` chains.
- Named functions; no IIFEs, no anonymous callbacks beyond one-line array methods, no nested ternaries.
- No dynamic imports, except in the portal for bundle splitting.
- Fallbacks only where a real default exists. Otherwise throw, and handle errors and missing values properly.
- Leave no dead code, unused exports or aliases behind.

## Tests

- Only load-bearing tests, end to end where possible.
- Tests beside the code are fast and offline; anything that runs real services lives in `e2e/`, or for the extension in `apps/extension/e2e/`, and is listed in e2e/README.md.
- Never read `process.env` in tests.
- A change to how a workflow judges or reviews states its package's eval result before and after.

## Docs

- Docs follow the change: a pull request that changes behaviour, options, routes or screens updates the affected README, docs/ and `docs/Corbits Triage User Manual/` in the same pull request, or says in its description why none needed a change.
- User docs say what a person sees and does, not how the code does it; mechanics belong in docs/ARCHITECTURE.md.
