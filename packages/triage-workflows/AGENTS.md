Follow the [root AGENTS.md](../../AGENTS.md).

- This package holds the triage steps the manager and the judge share (`triage-steps.ts`, `actions/`, `logic/`), `repo-scan`, and the `pr-triage` definition that runs the steps locally for the tests, the evals, the policy check and the extension. The hub deploys nothing defined here.
- Every step is a stock primitive: `action` for every deterministic step, an agent only for the judge step. Never wrap a deterministic step in `defineAgent`. A step that reaches the pull request's host (facts, mirror, execute) is an `action` that declares the host's credential handle and an `effect.requires` capability, and makes each call inside `ctx.perform`'s `run` ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md#triage-pipeline)).
- The rules that run in code read every patch up to their own ceiling; the judge's budgets apply only to what the judge is sent.
- Verdicts: a failed rule decides Fail without the verdict question, unless its `onFail` is `ask` (Unsure) or `label`; an unconfirmed judged rule makes a pass Unsure; a policy with no decision-model rule passes when every rule passes; otherwise one Choice question decides.
- `bun run eval` calls a paid model ([DECISION_MODEL.md](../../docs/DECISION_MODEL.md)).
