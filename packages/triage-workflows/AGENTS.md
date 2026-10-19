# Triage workflows

- pr-triage is stock primitives: `onTrigger` for mail, `action` for every deterministic step (rules, evaluation, dispatch), `loop` or `childWorkflow` for repetition.
- An agent exists only where inference happens: the judge step. Never wrap a deterministic step in `defineAgent`. A step that reaches the pull request's host (facts, mirror, execute) is an `action` that declares the host's credential handle and an `effect.requires` capability, and makes each call inside `ctx.perform`'s `run` (docs/ARCHITECTURE.md).
- Verdicts: a failed rule decides Fail without the verdict question; an unconfirmed judged rule makes a pass Unsure; a policy with no decision-model rule passes when every rule passes; otherwise one Choice question decides.
- Each host's package (`pr-triage-github`, `pr-triage-bitbucket-datacenter`) is built by `prTriage({ sources })` and binds only that host's credential.
- The eval is `bun run eval` here (docs/DECISION_MODEL.md); it calls a paid model.
