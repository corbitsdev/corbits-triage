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
bun run eval        # decision-model eval; calls a paid model
bun run eval:scan   # repository scan eval
```

## Test

```sh
bun --conditions=intx-src test packages/triage-workflows
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#triage-pipeline)
- [DECISION_MODEL.md](../../docs/DECISION_MODEL.md)
- [evals/SCAN.md](evals/SCAN.md)
