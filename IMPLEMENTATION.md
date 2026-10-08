# Implementation

Bun, TypeScript, Postgres, React + Vite. Interchange is consumed from
`vendor/interchange` with the `intx-src` export condition.

## Hub (`apps/hub`)

| File | Role |
| --- | --- |
| `src/env.ts` | Only reader of the environment. arktype schema; `databaseConfig` parses `DATABASE_URL`. |
| `src/server.ts` | Composition root: loads env, runs migrations, builds every component and injects config. |
| `src/interchange-hub.ts` | Mirror of the stock hub bootstrap with the database config, auth config, credential cipher and Interchange settings injected. |
| `src/auth.ts` | better-auth config: stock settings, optional Google sign-in and email allowlist, `PORTAL_ORIGIN` as a trusted origin. |
| `src/portal.ts` | Serves the built portal (`PORTAL_DIR`) and exact-origin CORS (`PORTAL_ORIGIN`). |
| `src/hooks.ts` | `@corbits/webhooks` mount and its migrations. |
| `src/sidecar/` | Local-process `SidecarProvisioner`: child-process lifecycle, spawn env, encrypted manifests, boot restore. |
| `src/sidecar-config.ts` | Sidecar adapter manifest (System One model provider, GitHub App credential adapter). |
| `src/github/bridge.ts` | HMAC verify, installation events → `corbitsTriage.repos`, PR events → run-trigger deliverer. |
| `src/github/deployment.ts` | `resolveLiveDeployment(db, tenantId, name)`. |
| `src/github/manifest.ts` | `GET/POST /api/integrations/github-manifest/{start,callback,cancel}`. |
| `src/github/pr-actions.ts` | `POST /api/integrations/github-actions/:tenantId`. |
| `src/github/github-app-*` | Credential adapter: App JWT → installation token, cached per installation, pinned to the GitHub API origin. |

### Environment

Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`,
`BETTER_AUTH_BASE_URL`, `PORT`, `HUB_DATA_DIR`.

Optional: `PORTAL_DIR`, `PORTAL_ORIGIN`, `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS`, `GITHUB_API_ORIGIN` (emulator), `HUB_SIDECAR_WEBSOCKET_URL`,
`HUB_SIDECAR_STOP_TIMEOUT_MS` (25000), `PG_SCHEMA`, `DB_STATEMENT_TIMEOUT_MS` (60000).

Optional Interchange settings (unset keeps the stock default):
`HUB_MAX_TARBALL_BYTES` (10485760), `HUB_AGENT_GC_PACK_THRESHOLD` (64),
`HUB_AGENT_GC_LOOSE_THRESHOLD` (2048), `HUB_AGENT_GC_WARN_BYTES` (268435456),
`HUB_PROBE_TIMEOUT_MS` (60000), `WORKFLOW_DEFAULT_MAX_LIFETIME` (`7d`),
`WORKFLOW_DEFAULT_RETENTION_COMPLETED` (`30m`),
`WORKFLOW_DEFAULT_RETENTION_FAILED` (`24h`),
`WORKFLOW_DEFAULT_RETENTION_CANCELLED` (`1h`).

GitHub App credentials are not environment: they live in the hub vault as
provider `github` (`{"appId","privateKey"}`) and `github-hook` (webhook
secret with `metadata.webhook`).

### Non-default GitHub origin

Workflow children start with a fresh environment, and Bun drops the query
from `import.meta.url`, so the origin cannot reach the adapter at runtime.
`sidecar-config.ts` writes a generated adapter entry module into
`HUB_DATA_DIR` with the origin baked in.

## Portal (`apps/web`)

- `src/lib/portal.tsx`: convergence on sign-in.
- `src/lib/workflow-deploy.ts`: `suggestOfferings` matches tenant offerings;
  `ensureWorkflows` creates each workflow asset, pushes its source and
  deploys, redeploying only when the source changed.
- `src/lib/git-push.ts`: browser git push with isomorphic-git and
  LightningFS, speaking receive-pack to the hub's asset git endpoint.
- `scripts/build-workflows.ts`: bundles `packages/triage-workflows` into
  `public/workflows/<name>/` (`package.json`, entry `.mjs`, `directors.mjs`).
- `src/lib/hub-api.ts`: typed calls over stock hub routes.
- `src/lib/decision-models.ts`: presets (TypeSafe, Vercel AI Gateway) plus
  custom. Saving stores the key as a vault credential, sets the
  `corbits-system-one` provider `baseURL`, and points the `decision` catalog
  model's offering at the provider's own model name (`quirks.model`).

### Decision model

The workflows declare one catalog model, `corbits-system-one:decision`, so
their source is identical for every tenant. The tenant's offering for
`decision` picks the provider (`baseURL` + `/systemone`) and wire model
(`@corbits/system-one` ≥ 0.3.1). Saving a model redeploys, because a
deployment resolves its offering when deployed.

## Packages

- `triage-workflows`: `pr-triage`, `pr-triage-historical`, custom
  directors (needs vendored PR #193).
- `github-tool`: GitHub reads, mirror write (marker-comment upsert) and
  merge; sidecar tool bundles.
- `github-write-tool`: build wrapper for the write bundle.
- `triage-contracts`: check-pack schema (`check-pack/{owner}/{repo}`), repo
  policy, shared types.
- `rule-packs`: deterministic presets.
- `openai-null-delta`: inference adapter fix for null stream deltas.

## Vendored deltas

| Delta | Why | Kill date |
| --- | --- | --- |
| PR #193 / INTR-581 | Custom directors | 2026-11-01 |
| INTR-583 | Operator-registered model provider plugins | 2026-11-01 |
| CL-10178 | Run-scoped `onTrigger` child run ids, with backward-compatible resume | 2026-11-01 |

## Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md). One image (`docs/Dockerfile`): the hub,
serving the built portal from `PORTAL_DIR`.

## Local development

See [docs/DEV.md](docs/DEV.md). The `emulate` GitHub emulator
(`emulate.config.yaml`) runs on port 4000 with `GITHUB_API_ORIGIN` set.
