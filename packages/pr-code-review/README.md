# @corbits/pr-code-review

The `pr-code-review` workflow, on no provider in particular: one mail names one pull request and the run returns a
review, a summary and one comment per defect anchored to its lines. Each provider's package builds it from a provider
profile (`src/profile.ts`); the hub imports its placement.

## Use

Every file under `src/` is a subpath export (`@corbits/pr-code-review/pr-code-review`, `/agents`, `/directors`,
`/findings`, `/profile`, `/actions/review`, `/actions/checkout`, `/actions/lint`).
`codeReviewSteps(agents, sources, { prefix, request, after })` places the same steps in another definition, every id
under `prefix`, as `codeReviewReviewer`, the review a pull request's manager deploys, does.

The request is `{ kind: "code-review", title, description, diff, checkout }`. The title and description are as the host
shows them, without hidden text. Optional fields are `number` (the pull request's), `efforts` per step,
`budgets.repoFinder` (400,000 billable tokens by default), `budgets.check` (each check's, 100,000 by default),
and `budgets.checkTotal` (all of a review's checks together, 400,000 by default). The diff is reviewed whole: no
prompt carries it, and the steps read it from the checkout.

### Process

1. **checkout** puts the head in a folder on the sidecar and writes the whole diff into it under `.corbits/diff/`: one
   patch per changed file, split into numbered parts past 1,500,000 bytes, none for a deleted file, and
   `index.jsonl` listing each file's path, status, line count and patch files.
   **plan** then reads the index and patches there within a token budget (400,000 billable tokens) and names the risky changed areas
   and the code outside the diff they depend on. Each review runs in a deployment of its own; releasing it when the run ends,
   failed or not, removes the sidecar and the checkout with it.
   **lint** then runs the sidecar's pinned oxlint with the repository's `.oxlintrc.json` over the changed files and
   keeps hits on added lines; only its data keys are kept, a config with any other key is refused unrun, and with none
   it is `skipped`. It answers `complete` with findings (`ToolFinding` in `src/findings.ts`), `skipped` or
   `incomplete`; a failure is never an empty list.
2. **findDiff** reads the patches from the folder within a token budget (400,000 billable tokens); **findRepo** reads
   them and the rest of the folder within `budgets.repoFinder`. They run in parallel, each given the index's path. An
   answer with no findings list fails the finder's step; a finder that spent its budget before answering found nothing
   and the review says it stopped early. Each finder's reply ends with the lines of each patch file it was shown, and
   the review is `complete` only when the two between them were shown every line and neither spent its budget.
3. **candidates** folds exact duplicates (same file, same lines, same title ignoring case and spacing, or,
   when neither has a title, the same explanation and the same quoted line wherever both quote one) and remembers
   which finders reported each finding.
4. **consolidate** reads the lines each finding cites at the head, moves it onto its quoted line and groups the
   findings by defect. A group none of whose findings had a line of its file shown to the model is marked `unverified`.
5. **check** verifies each group on every review: the finding, the diff hunks that change its lines, and the read
   tools on the checkout. The total is handed out up front, in review order, each group getting `budgets.check` or
   what is left of `budgets.checkTotal`, so with the defaults the four most serious groups are checked; later groups
   are unsure, "check budget spent", and post only when both finders reported them. The check answers real when lines
   it read show the claimed behaviour, reached by the trigger with no guard and not intended by the description; not
   real only when a line of code disproves it; unsure when it cannot decide. A real or not real reason that cites, as
   path:line, no line it read (in the hunks or with the tools) is unsure, its reason led by "no cited line". Once a
   check has been refused a read for its budget, only a not real that cites such a line stands; anything else is
   unsure.
   A group is posted when it is real, or unsure and both finders reported it; any other is left out of the review and
   kept in its `dropped`, in its finder's words with the verdict and reason.
6. **write** comments on every group left, most severe and most agreed-on first; each comment carries the code it
   quotes and how many finders reported it.

A failed model call fails its step, as does an answer that can't be read; every model step then tries again twice, 5
and 10 seconds later. A step that fails for good fails the review, which shows as not finished.

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
