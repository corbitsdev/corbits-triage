# @corbits/pr-code-review

The `pr-code-review` workflow, on no provider in particular: one mail names one pull request and the run returns a
review, a summary and one comment per defect anchored to its lines. Each provider's package builds it from a provider
profile (`src/profile.ts`); the hub imports its workflow addresses and placement.

## Use

Every file under `src/` is a subpath export (`@corbits/pr-code-review/pr-code-review`, `/agents`, `/directors`,
`/findings`, `/profile`, `/actions/review`, `/actions/checkout`).

The request is `{ kind: "code-review", title, description, diff, checkout }` with optional `number` (the pull
request's), `efforts` per step, `budgets.repoFinder`, `check`, and `cut` (`{ lines, of }`) when the sender cut the diff
for size, which the review carries.

### Process

1. **plan** names the risky changed areas and the code outside the diff they depend on; meanwhile **checkout** puts the
   head in a folder on the sidecar. Each review runs in a worker deployment of its own; releasing it when the run ends,
   failed or not, removes the sidecar and the checkout with it.
2. **findDiff** reads the diff; **findRepo** reads that folder within a token budget. They run in parallel.
3. **candidates** folds exact duplicates (same file, overlapping lines, same first quoted line) and remembers which
   finders reported each finding.
4. **consolidate** reads the lines each finding cites at the head, moves it onto its quoted line and groups the
   findings by defect.
5. **check** confirms each group, only when the request sets `check`.
6. **write** comments on every group, most severe and most agreed-on first; each comment carries the code it quotes
   and how many finders reported it.

Every message wraps pull request text in lowercase tags. Text from the pull request, its files or a model's reply
about them has each `<` that would open or close one of those tags, spelled as the prompts write it, written as
`\u003c`, and a `"` in a tag attribute as `&quot;`; all other text, code included (`<Finding>` and `<Title>` among it),
reaches the model as written.

### Adding a provider

Stock Interchange locks each step's provider and model into the package that declares them, so a provider is a
package of its own, `packages/pr-code-review-<provider>`, shaped like
[pr-code-review-anthropic](../pr-code-review-anthropic):

1. `src/profile.ts`: a `CodeReviewProfile` with the workspace package name, the catalog provider, the model and
   default effort for each step, and `billableTokens`, the tokens of one repository finder turn charged to its budget
   (count what the provider bills anew each turn).
2. Build the directors once with `codeReviewDirectors(profile, sidecarDataDir)` and the agents once with
   `codeReviewAgents(profile, directors, sidecarDataDir)`. `src/directors.ts` exports the directors' factories and
   nothing else; `src/actions/index.ts` re-exports the actions of `@corbits/pr-code-review/actions/review` with
   `reviewInput = reviewInputFor(profile)`, and `checkout` from `@corbits/pr-code-review/actions/checkout`.
3. `src/pr-code-review.ts` is `codeReviewWorkflow(agents)`, and one entry per host builds it under
   `PR_CODE_REVIEW_GITHUB_ADDRESS` or `PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS`, so the hub mails it whichever
   provider runs it.
4. Add the provider, the credential that holds its key and its models to `CODE_REVIEW_PROVIDERS` in
   `triage-contracts`, its models and catalog provider to `DECLARED_MODELS` in `apps/web/src/lib/model-catalog.ts`,
   and one row per host to `WORKFLOW_PACKAGES` in `apps/web/src/lib/workflow-packages.ts` with its own `packageName`
   and the same `name`. The portal deploys the rows of the provider whose key the workspace stores.
5. Give it an eval like [pr-code-review-anthropic/evals](../pr-code-review-anthropic/evals/README.md).

## Test

No tests of its own; a provider package's tests and eval run it:

```sh
bun --conditions=intx-src test packages/pr-code-review-anthropic
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#code-review-pipeline): how the hub feeds reviews in and sends them to
  the host
- [PRODUCT.md](../../docs/PRODUCT.md#code-review)
