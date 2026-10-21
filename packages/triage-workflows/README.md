# @corbits/triage-workflows

The triage workflows (`pr-triage-github`, `pr-triage-bitbucket-datacenter`, `pr-triage-historical`, `repo-scan`), their
steps and directors, and the deterministic logic under `src/logic/`. The hub and the extension import it.

## Use

Every file under `src/` is a subpath export:

```ts
import { workflow } from "@corbits/triage-workflows/pr-triage-github";
import { NEEDS_JUDGE_REASON, type Verdict } from "@corbits/triage-workflows/logic/render";
```

```sh
bun run eval                  # decision-model eval; calls a paid model
bun run eval:scan             # repository scan eval
bun run eval:hidden-content   # hidden-content rule eval; calls no model
```

`bun run eval -- --baseline` also writes `evals/results/pr-triage-judge.baseline.json`: the commit, the judge's provider,
model and tokens with its price, source and `pricesAsOf` date (a rate with no recorded price reads `unknown`, and a cost
that needs it is null), each case's verdict and rule answers, and each check's totals. It refuses on a dirty working tree
or when any case's repository is not public. The writer (`evals/baseline.ts`) and price table (`evals/prices.ts`) are
shared with the code review eval. The committed file is the baseline for the commit it names; rerun and commit it when a
change moves the numbers.
`evals/judge.eval.ts` exports the eval, which runs any definition that triages; pr-workflow-anthropic runs it through its own.

## Test

```sh
bun --conditions=intx-src test packages/triage-workflows
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#triage-pipeline)
- [DECISION_MODEL.md](../../docs/DECISION_MODEL.md)
- [evals/SCAN.md](evals/SCAN.md)
