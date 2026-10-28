Follow the [root AGENTS.md](../../AGENTS.md).

- The judge only infers: it runs the shared judge, parts and evaluate steps from `@corbits/triage-workflows` and reports the verdict through the hub. It never writes to the pull request.
- Its budget is its own. A limit here never changes what the manager's rules read or what code review sees.
- Takes mail only from the manager that deployed it, and declares no grant beyond reporting a result and stopping itself.
