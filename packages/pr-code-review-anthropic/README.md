# @corbits/pr-code-review-anthropic

The `pr-code-review` workflow: one mail names one pull request and the run
returns a review, a summary and one comment per defect anchored to its lines.
`prCodeReview({ sources })` builds it for the hosts given;
`pr-code-review-github` and `pr-code-review-bitbucket-datacenter` are the
deployed packages, each binding only its host's read credential.

## Process

1. **plan** names the risky changed areas and the code outside the diff they
   depend on.
2. **findDiff** reads the diff; **findRepo** checks the head out and reads the
   repository within a token budget. They run in parallel and write findings
   in prose, each with a priority and a confidence from 1 to 10.
3. **recoverDiff** and **recoverRepo** turn each finder's prose into
   structured findings.
4. **candidates** folds exact duplicates (same file, overlapping lines, same
   first quoted line) and remembers which finders reported
   each finding.
5. **consolidate** reads the lines each finding cites at the head, moves it
   onto its quoted line and groups the findings by defect.
6. **check** confirms each group, only when the request sets `check`.
7. **write** comments on up to five groups with a confidence of at least 6,
   most severe, then most confident, then most agreed-on first; each comment
   ends with how many finders reported it. The rest are returned as `held`.

The request is `{ kind: "code-review", title, description, diff, checkout }`
with optional `efforts` per step, `budgets.repoFinder` and `check`.
`docs/ARCHITECTURE.md` has the detail; `evals/README.md` has the eval and its
numbers.
