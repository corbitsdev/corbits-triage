Follow the [root AGENTS.md](../../AGENTS.md).

- The manager is the only workflow that writes to a pull request. It posts at once, waits for the judge and code review itself, and ends after its final post or while its head waits only on CI, which the reconciler wakes again once CI settles ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md#lifecycle-of-a-pull-request)).
- The judge and code review are workflows the manager deploys and waits for, never steps inside it; they report through the hub and post nothing.
- Logic the judge or the local `pr-triage` definition also needs belongs in `@corbits/triage-workflows`; this package holds only what the listener and the manager alone do.
- The listener holds no state of its own: the hub's claim decides which manager a pull request has.
