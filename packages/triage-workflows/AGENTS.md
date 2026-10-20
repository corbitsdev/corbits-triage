Follow the [root AGENTS.md](../../AGENTS.md).

- pr-triage is stock primitives: `onTrigger` for mail, `action` for every deterministic step (rules, evaluation, dispatch), `gate` for branching, `map` for repetition.
- An agent exists only where inference happens: the judge step. Never wrap a deterministic step in `defineAgent`. A step that reaches the pull request's host (facts, mirror, execute) is an `action` that declares the host's credential handle and an `effect.requires` capability, and makes each call inside `ctx.perform`'s `run` ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md)).
- Verdict logic is `renderVerdict` in `logic/render.ts`; [DECISION_MODEL.md](../../docs/DECISION_MODEL.md) is its spec and changes with it.
- Each host's package (`pr-triage-github`, `pr-triage-bitbucket-datacenter`) is built by `prTriage({ sources })` and binds only that host's credential.
- `bun run eval` calls a paid model ([DECISION_MODEL.md](../../docs/DECISION_MODEL.md)).
