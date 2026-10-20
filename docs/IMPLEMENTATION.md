# Implementation

Where the code lives. How it fits together is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

Bun, TypeScript, Postgres, Hono with hono-openapi and arktype on the hub,
React + Vite on the portal. Interchange is consumed from `vendor/interchange`
with the `intx-src` export condition, so every hub command runs with
`--conditions=intx-src`.

## Hub (`apps/hub`)

| Path | Role |
| --- | --- |
| `src/env.ts` | The only reader of the environment: arktype schema plus the helpers that turn it into config. |
| `src/server.ts` | Composition root: loads env, runs migrations, builds every component, injects config, registers the sidecar provisioners. |
| `migrations/*.sql`, `src/triage-db.ts` | Triage's tables in the `corbits_triage` schema, applied at start in one transaction under an advisory lock. |
| `src/interchange-hub.ts` | Mirror of the stock hub bootstrap with the database, auth, credential cipher and Interchange settings injected. |
| `src/auth.ts`, `src/sessions.ts` | better-auth config (Google sign-in, email allowlist, device authorization, `PORTAL_ORIGIN`) and the caller's own sessions. |
| `src/portal.ts` | Serves the built portal (`PORTAL_DIR`) and exact-origin CORS (`PORTAL_ORIGIN`). |
| `src/hooks.ts`, `src/provider-hooks/` | `@corbits/webhooks` mount; webhook intake for hosts other than GitHub. |
| `src/integrations/app.ts` | The `/api/integrations/*` routes and their OpenAPI descriptions. |
| `src/artifact-grants.ts` | Grants each new artifact's writes to its creator and the admin role. |
| `src/audit-log.ts` | The audit list, read from what the workspace already recorded. |
| `src/invitations/` | Invites as stock invited principals with magic links, and invite email over SMTP. |
| `src/workflow-deploy.ts`, `src/workflow-versions.ts` | Deploys the portal's published workflow versions; lists what is deployed. |
| `src/code-review.ts`, `src/code-review-feed.ts`, `src/code-review-runs.ts` | The code review switch; `…/place`, the selected provisioner and each place probed at boot (`dockerPlaces`); `…/run`; the feed that mails each new head; the latest review, read from run logs, and whether a head takes it over. |
| `src/sidecar/` | Local-process `SidecarProvisioner` (lifecycle, spawn env, encrypted manifests, boot restore, `host-capacity.ts`) and Docker registration (`docker.ts`). |
| `src/sidecar-config.ts` | Sidecar adapter manifest (System One model provider). |
| `src/bitbucket-datacenter/` | Bitbucket Data Center connection, repository and webhook routes, payload normalizing. |
| `src/github/bridge.ts` | GitHub webhook verification and routing; `logJson`, the hub's one JSON-line logger, passed down as `log`. |
| `src/github/tenant-config.ts` | Reads and writes `corbitsTriage` in tenant config; checks the stock tenant patch. |
| `src/github/policy-file.ts`, `check-pack-store.ts`, `policy-read.ts`, `policy-pull.ts` | The policy file (read again when a push touches it or a pull request merges into the default branch), the stored policy and which applies, the policy route, and the one `corbits-triage/policy` pull request. |
| `src/github/automation.ts` | Which action kinds triage writes unattended, from the `pr-triage` role's grants. |
| `src/github/coalescer.ts` | Folds a pull request's webhook burst into one mail. |
| `src/github/coordinator.ts`, `worker-spawn.ts` | The job queue and one worker deployment per job. |
| `src/github/triage-reconciler.ts`, `reconcile-plan.ts`, `reconcile-loop.ts`, `triage-queue.ts` | Re-queues untriaged and stale heads, rotates deployments and redeploys failed ones. |
| `src/github/triage-state-store.ts` | The per-repository triage state artifact. |
| `src/github/tenant-observer.ts`, `run-recorder.ts`, `triage-runs.ts` | Reads run logs and records verdicts. |
| `src/github/verdict-record-store.ts`, `triage-verdicts.ts`, `triage-stats.ts`, `triage-timeline.ts`, `pr-outcomes.ts` | Verdict records and the routes that serve them, including outcomes before and after Triage. Outcomes read at most the 50 newest-created pull requests on GitHub, or the newest page holding any (at most 8 pages of 50) on Bitbucket Data Center, with at most 8 reads at once, cached per pull request and per UTC day. |
| `src/github/backlog-triage.ts` | Mails `pr-triage-historical` to triage a repository's open pull requests. |
| `src/github/manifest.ts` | GitHub App Manifest flow; setup state is an HMAC token keyed from `BETTER_AUTH_SECRET`, valid 10 minutes. |
| `src/github/pr-*.ts`, `held-dos.ts` | Pull request actions, details and single-PR triage; approving a held action. |
| `src/github/github-app-credential-adapter.ts` | The hub's GitHub fetch: App JWT to installation token, cached per installation. |
| `src/github/app-key.ts`, `installation-token.ts` | The hub-only App key; the `github` credential's installation token, minted and renewed on the hub and pushed to running deployments. |
| `src/github/source-fetch.ts` | A repository's host fetch, as the GitHub App or the Bitbucket token. |

## Portal (`apps/web`)

- `src/lib/portal.tsx`: convergence on sign-in.
- `src/lib/hub-api.ts`: typed calls over the hub routes.
- `src/lib/model-catalog.ts`: the models the workflows name (`decision` on
  `corbits-system-one`, `claude-opus-5-5` and `claude-haiku-5-5` on
  `anthropic`); adds what the tenant catalog lacks through the stock catalog
  routes, and picks each deploy's offerings.
- `src/lib/workflow-deploy.ts`: publishes the tool and workflow tarballs to the
  tenant's `corbits` package registry and deploys each workflow pinned to its
  version, redeploying only when the version or its model's key changed. Code
  review deploys only while a connected repository has it on and a provider
  key is stored. Before publishing it removes tarballs neither this build nor
  a live deployment pins, since Interchange delivers the registry's whole tree
  under a 32 MiB cap.
- `scripts/build-workflows.ts`: packs the tools and workflows into
  `public/packages/` with `index.json`. Each version is
  `<base>-sha-<8 hex>` over the package's files (`tooling/pack-tarball.ts`),
  so any change publishes a new version.

The workflows name one decision model, `corbits-system-one:decision`, so their
source is the same for every tenant. Saving a model key stores it in the vault
and writes the `decision` offering (endpoint as the provider's `baseURL`, the
provider's own model as `quirks.model`), then redeploys, because a deployment
resolves its offering when deployed. Removing a key first releases the
workflows that use it, then deletes its catalog provider and offerings, since
the vault keeps a key a catalog provider uses.

The portal reads two build-time variables: `VITE_HUB_URL` (the hub's origin
when the portal is hosted apart) and `VITE_GITHUB_API_ORIGIN` (the GitHub
emulator).

## Extension (`apps/extension`)

A WXT browser extension that checks the open GitHub pull request locally; see
[its README](../apps/extension/README.md).

## Packages

| Package | Holds |
| --- | --- |
| `triage-workflows` | `pr-triage-github`, `pr-triage-bitbucket-datacenter`, `pr-triage-historical`, `repo-scan`, their steps, the judge's director, the actions under `actions/`, the deterministic logic under `logic/`, and the decision-model eval. |
| `triage-contracts` | Policy schema and parsers, the policy file, workspace policy resolution, repository settings, triage state, labels, trigger mail and shared types; see [its README](../packages/triage-contracts/README.md). |
| `github-reads`, `bitbucket-datacenter-reads` | Host read helpers, both returning the GitHub shapes. |
| `github-tool`, `bitbucket-datacenter-tool` | The sidecar tool bundles: reads, the mirror, and actions. |
| `repo-read-tool` | `read_file`, `grep` and `list`, read-only and confined to a checkout folder under the sidecar data dir's `checkouts` (no `..`, absolute path or symlink out); the host tool packages export `checkout` and their read bundles add `*_read_file`. |
| `pr-code-review`, `pr-code-review-anthropic` | The provider-neutral code review workflow and the Anthropic provider's package and eval; see [its README](../packages/pr-code-review/README.md). |
| `policy-check-action` | The GitHub Action that checks `.corbits-triage.yml` as the hub reads it, and runs the policy's rules that need no model on a pull request through pr-triage's `runLocal`. |
| `provisioner-docker`, `provisioner-template`, `provisioner-test` | The Docker provisioner, a template for a new backend, and the contract tests; see [provisioners/](provisioners/README.md). |
| `openai-null-delta` | Inference adapter fix for null stream deltas. |
| `common` | Dependency-free helpers shared across apps and packages. |

## Scripts

| Command | Does |
| --- | --- |
| `bun run dev` | Hub and portal with prefixed logs (`tooling/dev.ts`). |
| `bun run hub` | Hub only. |
| `bun run check` | Typecheck tooling, portal, extension, hub, packages and `e2e/`, and bundle the hub. |
| `bun run test` | Unit and integration tests; hub tests need Postgres. |
| `bun run lint` | oxlint. |
| `bun e2e/provisioners/<name>.ts` | Live checks against real services, by hand only; see [e2e/README.md](../e2e/README.md). |
| `bun run eval` in `packages/triage-workflows` | Decision-model eval; see [DECISION_MODEL.md](DECISION_MODEL.md#measured-accuracy). |
| `bun run eval:scan` in `packages/triage-workflows` | Repository scan eval; see `packages/triage-workflows/evals/SCAN.md`. |
| `bun run eval:review` | Code review eval; see `packages/pr-code-review-anthropic/evals/README.md`. |
| `bun run holdback`, `report` | Holdback replay, cost and latency report. |
| `bun run vendor:health`, `sh tooling/vendor-diff-check.sh` | Vendored Interchange health and drift gate. |

## Build

One image, the root `Dockerfile`: the hub serving the built portal from
`PORTAL_DIR`, on `oven/bun:1.4.2`, the Bun the Railway sidecar template installs and the Bun minor CI runs. Its `sidecar` target is
the image the Docker provisioner runs. See [SELF_HOST.md](SELF_HOST.md).
