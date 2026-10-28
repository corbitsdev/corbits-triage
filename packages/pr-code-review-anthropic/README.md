# @corbits/pr-code-review-anthropic

Code review on Anthropic's models: the [`@corbits/pr-code-review`](../pr-code-review/README.md) workflow built from the
Anthropic profile (`src/profile.ts`), Opus 5.5 for the diff finder and the check, and Haiku 5.5 for every other step. A workspace runs
it while its Anthropic key is stored.

## Use

`pr-code-review-reviewer-github` and `pr-code-review-reviewer-bitbucket-datacenter` are the deployed packages, each
binding only its host's read credential; a pull request's manager deploys its host's:

```ts
import { workflow } from "@corbits/pr-code-review-anthropic/pr-code-review-reviewer-github";
```

The repository finder's budget counts input, output and cache-write tokens: cache reads re-count the whole prompt on
every turn.

The eval runs from the repository root and calls Anthropic:

```sh
bun run eval:review
```

## Test

```sh
bun --conditions=intx-src test packages/pr-code-review-anthropic
```

## Docs

- [pr-code-review](../pr-code-review/README.md): the process and adding a provider
- [evals/README.md](evals/README.md): the eval and its numbers
