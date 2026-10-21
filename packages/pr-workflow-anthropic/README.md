# @corbits/pr-workflow-anthropic

The PR workflow with code review on Anthropic's models: one mail names one pull request, triage runs as
[pr-triage](../triage-workflows/README.md) does, then [code review](../pr-code-review-anthropic/README.md) runs behind a
gate, and approve and merge wait for the review. The hub does not deploy or mail it yet.

## Use

`pr-workflow-github` and `pr-workflow-bitbucket-datacenter` build the definition for one host each:

```ts
import { workflow } from "@corbits/pr-workflow-anthropic/pr-workflow-github";
```

The mail is pr-triage's plus `codeReview` and `codeReviewRequest`; the steps, the outcomes and how approve and merge
wait are in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#pr-workflow).

## Eval

```sh
bun run eval   # the triage judge eval through this workflow, code review off; calls System One, a paid model
```

## Test

```sh
bun --conditions=intx-src test packages/pr-workflow-anthropic
```
