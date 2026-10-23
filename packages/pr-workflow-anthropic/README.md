# @corbits/pr-workflow-anthropic

The PR workflow with code review on Anthropic's models: one mail names one pull request, triage runs as
[pr-triage](../triage-workflows/README.md) does, then [code review](../pr-code-review-anthropic/README.md) runs behind a
gate, by default only once triage's rules that need no model and CI have passed, and `decide` applies the policy's rules once to choose what execute runs. The hub mails it a pull request whose
policy file turns code review on, while the workspace stores the Anthropic key.

## Use

`pr-workflow-github` and `pr-workflow-bitbucket-datacenter` build the definition for one host each:

```ts
import { workflow } from "@corbits/pr-workflow-anthropic/pr-workflow-github";
```

The mail is pr-triage's plus `codeReview`, `codeReviewRequest`, `decide`, the policy's rules, and `blocks`, the blocks it turns on; the steps, the
outcomes and how `decide` chooses are in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#pr-workflow).

## Eval

```sh
bun run eval   # the triage judge eval through this workflow, code review off; calls System One, a paid model
```

## Test

```sh
bun --conditions=intx-src test packages/pr-workflow-anthropic
```
