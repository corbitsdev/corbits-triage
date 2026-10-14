# Implementation

## Stack

Bun, TypeScript, Postgres, Hono with hono-openapi and arktype on the hub,
React + Vite on the portal. Interchange is consumed from `vendor/interchange`
with the `intx-src` export condition, so every hub command runs with
`--conditions=intx-src`.

## Hub (`apps/hub`)

| Path | Role |
| --- | --- |
| `src/env.ts` | Only reader of the environment. arktype schema plus the helpers that turn it into config. |
| `src/server.ts` | Composition root: loads env, runs migrations, builds every component and injects config. |
| `migrations/*.sql`, `src/triage-db.ts` | Triage's tables in the `corbits_triage` schema, applied at start in one transaction under an advisory lock. |
| `src/interchange-hub.ts` | Mirror of the stock hub bootstrap with the database config, auth config, credential cipher and Interchange settings injected. |
| `src/auth.ts` | better-auth config: stock settings, optional Google sign-in and email allowlist, `PORTAL_ORIGIN` as a trusted origin. |
| `src/portal.ts` | Serves the built portal (`PORTAL_DIR`) and exact-origin CORS (`PORTAL_ORIGIN`). |
| `src/hooks.ts` | `@corbits/webhooks` mount and its migrations. |
| `src/integrations/app.ts` | The `/api/integrations/*` routes and their OpenAPI descriptions. |
| `src/invitations/` | Invites as stock invited principals with magic links, and invite email over SMTP. |
| `src/workflow-deploy.ts`, `src/workflow-versions.ts` | Deploys the portal's published workflow versions; lists what is deployed. |
| `src/sidecar/` | Local-process `SidecarProvisioner`: child-process lifecycle, spawn env, encrypted manifests, boot restore. |
| `src/sidecar-config.ts` | Sidecar adapter manifest (System One model provider, GitHub App credential adapter). |
| `src/github/bridge.ts` | HMAC verify, installation events → `corbitsTriage.repos`, pull request events → coalescer. |
| `src/github/coalescer.ts` | Folds a pull request's webhook burst into one mail. |
| `src/github/triage-reconciler.ts`, `reconcile-plan.ts`, `reconcile-loop.ts`, `triage-queue.ts` | Re-queues untriaged and stale heads, rotates `pr-triage` deployments and redeploys failed ones. |
| `src/github/triage-state-store.ts` | The per-repository triage state artifact. |
| `src/github/tenant-observer.ts`, `run-recorder.ts`, `triage-runs.ts` | Reads `pr-triage` run logs and records verdicts. |
| `src/github/verdict-record-store.ts`, `triage-verdicts.ts`, `triage-stats.ts`, `triage-timeline.ts` | Verdict records and the routes that serve them. |
| `src/github/manifest.ts` | GitHub App Manifest flow: start and callback. The setup state is an HMAC-SHA256 token keyed from `BETTER_AUTH_SECRET`, valid 10 minutes and bound to the user who started it; nothing is stored. |
| `src/github/pr-*.ts` | Pull request actions, details, previews (API only) and single-PR triage. |
| `src/github/held-dos.ts` | Approves a held Do by mailing it to `pr-triage`. |
| `src/github/github-app-*` | Credential adapter: App JWT → installation token, cached per installation, pinned to the GitHub API origin. |

### Non-default GitHub origin

Workflow children start with a fresh environment, and Bun drops the query
from `import.meta.url`, so the origin cannot reach the adapter at runtime.
`sidecar-config.ts` writes a generated adapter entry module into
`HUB_DATA_DIR` with the origin baked in.

## Portal (`apps/web`)

- `src/lib/portal.tsx`: convergence on sign-in.
- `src/lib/workflow-deploy.ts`: `suggestOfferings` matches tenant offerings;
  `ensureWorkflows` publishes the tool and workflow tarballs to the tenant's
  `corbits` package registry and deploys each workflow pinned to its version
  through the hub's workflow-deploy route, redeploying a workflow only when
  its deployment runs another version or the decision model was saved.
- `scripts/build-workflows.ts`: packs the GitHub tools and each workflow of
  `packages/triage-workflows` as tarballs into `public/packages/`, listed in
  `index.json`. Each version is `<base>-sha-<8 hex>`, a SHA-256 over the
  package manifest and files (`tooling/pack-tarball.ts`), so any change to
  the tool or a workflow publishes a new version.
- `src/lib/hub-api.ts`: typed calls over the hub routes.
- Decision model presets (`@corbits/triage-contracts`): TypeSafe, Vercel AI
  Gateway, OpenCode Zen, all serving Jev, plus a custom provider. Saving
  stores the key as a vault credential, sets the `corbits-system-one` provider
  `baseURL`, and points the `decision` catalog model's offering at the
  provider's own model name (`quirks.model`).

### Decision model

The workflows declare one catalog model, `corbits-system-one:decision`, so
their source is identical for every tenant. The tenant's offering for
`decision` picks the provider (`baseURL` + `/systemone`) and wire model
(`@corbits/system-one` 0.3.1). Saving a model redeploys, because a deployment
resolves its offering when deployed.

## Extension (`apps/extension`)

A WXT browser extension that triages the open GitHub pull request locally; see `apps/extension/README.md`.

## Packages

- `triage-workflows`: `pr-triage`, `pr-triage-historical`, their steps
  (`triage-steps.ts`), directors and the deterministic logic under `logic/`.
- `github-reads`: GitHub read helpers and types.
- `github-tool`: the mirror write (marker-comment upsert), Dos and the sidecar
  tool bundles.
- `github-write-tool`: build wrapper for the write bundle.
- `triage-contracts`: policy schema (`schemaVersion` 2), repository settings, triage state,
  verdict labels, trigger mail and shared types.
- `openai-null-delta`: inference adapter fix for null stream deltas.
- `common`: dependency-free helpers shared across apps and packages.

## Environment

The hub reads the environment only in `apps/hub/src/env.ts`. Every variable
is described in [SELF_HOST.md](SELF_HOST.md#configuration) and in
`.env.example`. GitHub App credentials and model keys are not environment:
they live in the hub vault.

The portal reads two build-time variables: `VITE_HUB_URL` (the hub's origin
when the portal is hosted apart from it) and `VITE_GITHUB_API_ORIGIN` (the
GitHub emulator).

## Scripts

| Command | Does |
| --- | --- |
| `bun run dev` | Hub and portal with prefixed logs (`tooling/dev.ts`). |
| `bun run hub` | Hub only. |
| `bun run check` | Typecheck tooling, portal and hub, and bundle the hub. |
| `bun run test` | Unit and integration tests; hub tests need Postgres. |
| `bun run lint` | oxlint. |
| `bun run holdback`, `injection`, `report` | Eval scripts: holdback replay, prompt-injection run, cost and latency report. |
| `bun run eval:judge` | Decision-model eval over `evals/judge`. |
| `bun run vendor:health`, `sh tooling/vendor-diff-check.sh` | Vendored Interchange health and drift gate. |

## Build and deploy

One image, the root `Dockerfile`: the hub, serving the built portal from
`PORTAL_DIR`. Its base, `oven/bun:1.4`, matches the Bun minor CI runs. See [DEPLOY.md](DEPLOY.md).

## Vendored deltas

Each delta, its reason and its kill date are in
`vendor/interchange/VENDORED.md`.
