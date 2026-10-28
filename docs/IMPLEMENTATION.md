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
| `src/server.ts` | Composition root: loads env, checks the database is migrated, builds every component, injects config, registers the sidecar provisioners. |
| `src/migrate.ts`, `src/migrations.ts` | `db:migrate`: every migration and backfill; and the hub's start check. |
| `migrations/*.sql`, `src/triage-db.ts` | Triage's tables in the `corbits_triage` schema, applied by `db:migrate` in one transaction under an advisory lock. |
| `src/interchange-hub.ts` | Mirror of the stock hub bootstrap with the database, auth, credential cipher and Interchange settings injected. |
| `src/auth.ts`, `src/sessions.ts` | better-auth config (Google sign-in, email allowlist, device authorization, `PORTAL_ORIGIN`) and the caller's own sessions. |
| `src/portal.ts` | Serves the built portal (`PORTAL_DIR`) and exact-origin CORS (`PORTAL_ORIGIN`). |
| `src/hooks.ts`, `src/provider-hooks/` | `@corbits/webhooks` migrations and mount path; webhook intake for hosts other than GitHub. |
| `src/integrations/app.ts` | The `/api/integrations/*` routes and their OpenAPI descriptions. |
| `src/artifact-grants.ts` | Grants each new artifact's writes to its creator and the admin role. |
| `src/audit-log.ts` | The audit list, read from what the workspace already recorded. |
| `src/invitations/` | Invites as stock invited principals with magic links, and invite email over SMTP. |
| `src/workflow-versions.ts` | Lists what is deployed, the versions it runs and the hub's last roll of each host. |
| `src/workflow-release/` | Publishes the portal build's workflows as each workspace's `triage-publisher` system principal and rolls each connected host's listener onto them (`rollout.ts`, `publish.ts`, `publisher.ts`, `reads.ts`): at start for every workspace, and in the background after a host connects or a credential or catalog write. |
| `src/code-review.ts`, `src/pull-request-reader.ts`, `src/code-review-runs.ts` | `…/place`, the selected provisioner and each place probed at boot (`dockerPlaces`); `…/run`; reading a pull request and building its review request; the latest review, read from the manager's state, and whether a head takes it over. |
| `src/sidecar/` | Local-process `SidecarProvisioner` (lifecycle, spawn env, encrypted manifests, boot restore, `host-capacity.ts`) and Docker registration (`docker.ts`). |
| `src/sidecar-config.ts` | Sidecar adapter manifest (System One model provider). |
| `src/bitbucket-datacenter/` | Bitbucket Data Center connection, repository and webhook routes, payload normalizing. |
| `src/github/bridge.ts` | GitHub webhook verification and routing; `logJson`, the hub's one JSON-line logger, passed down as `log`. |
| `src/github/tenant-config.ts` | Reads and writes `corbitsTriage` in tenant config; checks the stock tenant patch. |
| `src/github/policy-file.ts`, `check-pack-store.ts`, `policy-read.ts`, `policy-pull.ts` | The policy file (read again when a push touches it or a pull request merges into the default branch, and at most a minute old while the repository's webhook (the App's, on GitHub) has been silent for half an hour), the stored policy and which applies, the policy route, and the one `corbits-triage/policy` pull request. |
| `src/github/automation.ts` | Which action kinds triage writes unattended, from the `pr-triage` role's grants. |
| `src/github/coalescer.ts` | Folds a pull request's webhook burst into one mail. |
| `src/github/triage-reconciler.ts`, `reconcile-plan.ts`, `reconcile-loop.ts`, `triage-queue.ts` | Re-queues untriaged and stale heads through the listener. |
| `src/github/triage-state-store.ts` | The per-repository triage state artifact. |
| `src/github/manager-runs.ts`, `triage-runs.ts` | The managers' runs of each open pull request as the reconciler and the verdicts route read them; the verdict and approval in a run's log, for held Dos and the audit log. |
| `src/github/verdict-record-store.ts`, `triage-verdicts.ts`, `triage-stats.ts`, `triage-timeline.ts`, `pr-outcomes.ts` | Verdict records and the routes that serve them, including outcomes before and after Triage. Outcomes read at most the 50 newest-created pull requests on GitHub, or the newest page holding any (at most 8 pages of 50) on Bitbucket Data Center, with at most 8 reads at once, cached per pull request and per UTC day. |
| `src/github/backlog-triage.ts` | Mails the host's listener a backlog to triage a repository's open pull requests. |
| `src/github/manifest.ts` | GitHub App Manifest flow; setup state is an HMAC token keyed from `BETTER_AUTH_SECRET`, valid 10 minutes. |
| `src/github/pr-*.ts`, `held-dos.ts` | Pull request actions, details and single-PR triage; approving a held action. |
| `src/github/github-app-credential-adapter.ts` | The hub's GitHub fetch: App JWT to installation token, cached per installation. |
| `src/github/app-key.ts`, `installation-token.ts`, `app-connection.ts` | The hub-only App key; the `github` credential's installation token, minted and renewed on the hub and pushed to running deployments; connecting an existing App. |
| `src/github/source-fetch.ts` | A repository's host fetch, as the GitHub App or the Bitbucket token. |

## Portal (`apps/web`)

- `src/lib/portal.tsx`: the workspace snapshot and the Settings actions.
- `src/lib/hub-api.ts`: typed calls over the hub routes.
- `src/lib/model-catalog.ts`: adds what the tenant catalog lacks for the
  models the workflows name (`DECLARED_MODELS` in `@corbits/triage-contracts`:
  `decision` on `corbits-system-one`, `claude-opus-5-5` and `claude-haiku-5-5`
  on `anthropic`) through the stock catalog routes.
- `src/components/settings/TriageVersions.tsx`: each connected host's running
  version and when it started, and the error of the hub's last roll when it
  failed, from the workflow-versions route.
- `scripts/build-workflows.ts`: writes each workflow of the manager chain
  (`CHAIN_PACKAGES` in `@corbits/triage-contracts`) as a source tree to
  `public/packages/sources/`, which the hub publishes: a
  workspace root whose members are the workflow bundle and the built host
  tools, since Interchange installs only npm dependencies from a registry.
  Each version is `<base>-sha-<8 hex>` over the package's files
  (`tooling/pack-tarball.ts`), so any change publishes a new version. Its
  bundles import `release.json` at run time
  through the package's `#release` import, which resolves from any file in it,
  and `src/loops.ts`, where a package has one, ships as `interchange.loops`.
  The chain's bundles run on Bun only: Bun's bundler drops the import's
  `with { type: "json" }`, which Node requires, and every sidecar runs Bun.

The workflows name one decision model, `corbits-system-one:decision`, so their
source is the same for every tenant. Saving a model key stores it in the vault
and writes the `decision` offering (endpoint as the provider's `baseURL`, the
provider's own model as `quirks.model`). Removing a key deletes its catalog
provider and offerings, since the vault keeps a key a catalog provider uses.

The portal reads two build-time variables: `VITE_HUB_URL` (the hub's origin
when the portal is hosted apart) and `VITE_GITHUB_API_ORIGIN` (the GitHub
emulator).

## Extension (`apps/extension`)

A WXT browser extension that checks the open GitHub pull request locally; see
[its README](../apps/extension/README.md).

## Packages

| Package | Holds |
| --- | --- |
| `triage-workflows` | The triage steps, `pr-triage`, the definition that runs them locally, `repo-scan`, the judge's director, the actions under `actions/`, the deterministic logic under `logic/`, and the decision-model eval. |
| `triage-contracts` | Policy schema and parsers, the policy file, resolving a file over the one it extends, repository settings, triage state, labels, trigger mail, the manager chain's workflows and the `release.json` each publishes (`workflow-release.ts`), and shared types; see [its README](../packages/triage-contracts/README.md). |
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
| `bun run dev` | Database migrations, then hub and portal with prefixed logs (`tooling/dev.ts`). |
| `bun run db:migrate` | Apply every database migration the hub needs to `DATABASE_URL`; run before the hub starts. |
| `bun run hub` | Hub only; does not migrate. |
| `bun run check` | Typecheck tooling, portal, extension, hub, packages, `e2e/` and `tests/chain/`, and bundle the hub. |
| `bun run test` | Unit and integration tests; hub tests need Postgres. |
| `bun run test:unit` | The tests that need no Postgres, files in parallel. |
| `bun run test:postgres` | The `*.postgres.test.ts` tests, files in parallel, each test on a database or schema of its own. |
| `bun run test:chain` | The live triage chain from webhook to pull request on one machine, against a fake GitHub and a stub decision model; needs Postgres and reaches the npm registry for native modules. |
| `bun run lint` | oxlint. |
| `bun e2e/provisioners/<name>.ts` | Live checks against real services, by hand only; see [e2e/README.md](../e2e/README.md). |
| `bun run eval` in `packages/triage-workflows` | Decision-model eval; see [DECISION_MODEL.md](DECISION_MODEL.md#measured-accuracy). |
| `bun run eval:scan` in `packages/triage-workflows` | Repository scan eval; see `packages/triage-workflows/evals/SCAN.md`. |
| `bun run eval:review` | Code review eval; see `packages/pr-code-review-anthropic/evals/README.md`. |
| `bun run holdback`, `report` | Holdback replay, cost and latency report. |
| `bun run vendor:health`, `sh tooling/vendor-diff-check.sh` | Vendored Interchange health and drift gate. |

## Build

One image, the root `Dockerfile`: the hub serving the built portal from
`PORTAL_DIR`, on `oven/bun:1.4.4` pinned by digest (`bun run check` fails on an unpinned `FROM`), the Bun the Railway sidecar template installs and the Bun minor CI runs. Its `sidecar` target is
the image the Docker provisioner runs. CI scans both with Trivy before publishing and fails on critical or high vulnerabilities that have a fix. Both hold only the production dependencies of the hub and the sidecar,
the sources they run from and, for the hub, the built portal; the `base` stage keeps the full install that builds the portal and supplies the oxlint binary to both. See [SELF_HOST.md](SELF_HOST.md).
