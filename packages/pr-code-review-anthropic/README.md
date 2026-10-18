# @corbits/pr-code-review-anthropic

Code review on Anthropic's models: the `@corbits/pr-code-review` workflow
built from the Anthropic profile (`src/profile.ts`), Opus 5.5 for the diff
finder and Haiku 5.5 for every other step. `pr-code-review-github` and
`pr-code-review-bitbucket-datacenter` are the deployed packages, each binding
only its host's read credential; a workspace runs them while its Anthropic key
is stored.

The repository finder's budget counts input, output and cache-write tokens:
cache reads re-count the whole prompt on every turn.

`packages/pr-code-review/README.md` has the process; `evals/README.md` has
the eval and its numbers.
