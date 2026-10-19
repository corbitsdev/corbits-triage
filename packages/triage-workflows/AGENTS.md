# Triage workflows

- pr-triage is stock primitives: `onTrigger` for mail, `action` for every deterministic step (rules, evaluation, dispatch), `loop` or `childWorkflow` for repetition.
- An agent exists only where inference happens: the judge step. Never wrap a deterministic step in `defineAgent`. Exception on this Interchange pin: facts, execute and mirror are `defineAgent` with a director and no model call, because an `action` cannot reach a bound credential (docs/ARCHITECTURE.md).
- Verdicts: a failed rule decides Fail without the verdict question; an unconfirmed judged rule makes a pass Unsure; a policy with no decision-model rule passes when every rule passes; otherwise one Choice question decides.
- Each host's package (`pr-triage-github`, `pr-triage-bitbucket-datacenter`) is built by `prTriage({ sources })` and binds only that host's credential.
- The eval is `bun run eval` here (docs/DECISION_MODEL.md); it calls a paid model.
- The worker holds one tool grant to write actions, because an `action` step cannot reach a bound credential on this pin.
