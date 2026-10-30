# @corbits/pr-code-review

The `pr-code-review` workflow, on no provider in particular: one mail names one pull request and the run returns a
review, a summary and one comment per defect anchored to its lines. Each provider's package builds it from a provider
profile (`src/profile.ts`); the hub imports its placement.

## Use

Every file under `src/` is a subpath export (`@corbits/pr-code-review/pr-code-review`, `/agents`, `/directors`,
`/findings`, `/profile`, `/actions/review`, `/actions/checkout`, `/actions/lint`).
`codeReviewSteps(agents, sources, { prefix, request, after })` places the same steps in another definition, every id
under `prefix`, as `codeReviewReviewer`, the review a pull request's manager deploys, does.

The request is `{ kind: "code-review", title, description, diff, checkout }`. Optional fields are `number`,
`efforts.diffFinder`, `efforts.check`, `budgets.check` (100,000 billable tokens per check), and
`budgets.checkTotal` (400,000 across all checks). Policy paths gate the whole review upstream; this workflow does not
filter individual files.

### Process

1. **checkout** puts the head in its own sidecar and writes the diff beside it, outside the pull request's tree.
   On-disk patches remain split at 1,500,000 bytes. **lint** runs unchanged after checkout; its findings are not posted
   and are not finder input.
2. **findersInput** assigns each non-deleted file independently. Its escaped user message includes the patch, title,
   description, repository and 400,000-token budget. Messages are capped at 120,000 UTF-8 bytes, including all wrappers
   and escaped text. Oversized files split in order at line ends or UTF-8 boundaries. Context or an indivisible
   character that cannot fit fails the review rather than truncating it.
3. **find** runs one finder sequentially per bundle. The patch is already in the message; read_file, grep and list
   are only for repository code outside that patch, not paging `/diff`.
4. **candidates** folds exact duplicates. Returning every assigned bundle means `complete: true`, including an empty
   assignment. This does not depend on tool-read coverage. Budget exhaustion stays a separate flag and still holds
   approval; it does not make a returned review incomplete.
5. **checks / check** verify each kept finding in severity order against its original anchors and relevant diff
   hunks. Checks retain their per-finding and total budgets and citation requirements. Only `real` survives;
   `not_real`, `unsure`, uncited verdicts and findings beyond the check budget are dropped with their reasons.
6. **review** constructs comments in the finder's original words without rewriting titles, explanations or anchors.
   Its summary is empty with comments, otherwise `No defects reported.` The manager alone posts to the pull request.
   No planning, repository-finder, consolidation or writing model runs on this path.

A failed model call or unreadable answer retries twice. A bundle that never returns leaves no review output and is
reported as `the review did not finish`, never as a new partial-read result. Stored reviews without `complete: true`
retain their incomplete note and approval hold.

Every message wraps pull request text in lowercase tags. Text from the pull request, its files or a model's reply
about them has each `<` that would open or close one of those tags, spelled as the prompts write it, written as
`\u003c`, and a `"` in a tag attribute as `&quot;`; all other text, code included (`<Finding>` and `<Title>` among it),
reaches the model as written.

### Adding a provider

Stock Interchange locks each step's provider and model into the package that declares them, so a provider is a
package of its own, `packages/pr-code-review-<provider>`, shaped like
[pr-code-review-anthropic](../pr-code-review-anthropic):

1. `src/profile.ts`: a `CodeReviewProfile` with the workspace package name, the catalog provider, the model and
   default effort for each step, and `billableTokens`, the tokens of one reader turn charged to its budget
   (count what the provider bills anew each turn).
2. Build the directors once with `codeReviewDirectors(profile, sidecarDataDir)` and the agents once with
   `codeReviewAgents(profile, directors, sidecarDataDir)`. `src/directors.ts` exports the directors' factories and
   nothing else; `src/actions/index.ts` re-exports the actions of `@corbits/pr-code-review/actions/review` with
   `reviewInput = reviewInputFor(profile)`, `checkout` from `@corbits/pr-code-review/actions/checkout` and `lint` from
   `@corbits/pr-code-review/actions/lint`.
3. `src/pr-code-review.ts` is `codeReviewWorkflow(agents)`, which the tests and evals run, and one entry per host,
   `src/pr-code-review-reviewer-<host>.ts`, builds `codeReviewReviewer(agents)` under that host's reviewer id, which
   the host's manager deploys.
4. Add the provider, the credential that holds its key and its models to `CODE_REVIEW_PROVIDERS` in
   `triage-contracts`, and its models and catalog provider to `DECLARED_MODELS` and one row per host to
   `CHAIN_PACKAGES`, both in `triage-contracts`' `workflow-release.ts`, the row with its own `packageName` and named
   in its host's manager row under `deploys`.
5. Give it an eval like [pr-code-review-anthropic/evals](../pr-code-review-anthropic/evals/README.md).

## Test

The lint step has tests of its own; a provider package's tests and eval run the rest:

```sh
bun --conditions=intx-src test packages/pr-code-review packages/pr-code-review-anthropic
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#code-review-pipeline): how the hub feeds reviews in and sends them to
  the host
- [PRODUCT.md](../../docs/PRODUCT.md#code-review)
