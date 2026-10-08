# Corbits Triage

PR and backlog triage for GitHub repositories, running as workflows on a stock [Interchange](https://github.com/faremeter/interchange) hub. Interchange is the control plane (identity, grants, approvals, credentials, runs, audit).

## Layout

- `apps/web`: portal. After sign-in it converges everything over stock hub routes: tenant, GitHub App credentials, workflow source and deployments (onto the tenant's System One offerings). Prebuilt workflow bundles ship with it (`scripts/build-workflows.ts`)
- `apps/hub`: hub composition — stock `@intx/hub-api` plus `@corbits/webhooks` at `/api/hooks` (replay table is the library's). Mounted on the same block: `@corbits/artifacts`, `@corbits/cron`. Custom routes: GitHub App Manifest `GET/POST /api/integrations/github-manifest/{callback,start,cancel}` (PEM never in the browser) and synchronous pull request writes `POST /api/integrations/github-actions/:tenantId` (comment, review, merge, close). Temporary exception: HMAC intercept on `/api/hooks*` for `X-Hub-Signature-256` until `@corbits/webhooks` adds a GitHub verifier; it delivers to the tenant's live deployment as the system sender, like cron
- `packages/triage-workflows`: `pr-triage` (PR event mail listener) and `pr-triage-historical` (connect / added-repo / manual catch-up)
- `packages/github-tool`, `packages/github-write-tool`: read-only GitHub tools and the triage mirror write
- `packages/triage-contracts`, `packages/rule-packs`: types and deterministic checks
- `vendor/interchange`: pin `779b47f5` plus deltas in `vendor/interchange/VENDORED.md`
- `tooling/`: dev runner, eval scripts
- `docs/`: [DEV](docs/DEV.md) (local setup), [DEPLOY](docs/DEPLOY.md), [SELF_HOST](docs/SELF_HOST.md)

## Quickstart

```sh
bun install
cp .env.example .env   # four secrets + database
bun run dev
```

Then follow [DEV.md](docs/DEV.md) step 5 in the portal. `.env` holds only Interchange settings; GitHub credentials live in the hub vault and deployments are found by workflow name.

Merge via the GitHub API needs GitHub App `contents: write` in addition to `pull_requests: write`; existing installs must accept the new permission on GitHub.

Eval scripts: `bun run holdback | injection | report`.

## License

GPLv2 with the [AI Exception](GPLv2-AI-Exception.md); see [LICENSE.md](LICENSE.md). Contributions require the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues per [SECURITY.md](SECURITY.md).
