Follow the [root AGENTS.md](../../AGENTS.md).

- Rules run from the shared packages the hub runs (`@corbits/triage-contracts`, `@corbits/triage-workflows`); never fork rule logic here.
- Read-only: it reads GitHub with the user's token and writes nothing.
- `e2e/verify.ts` takes the GitHub token on stdin, never on the command line.
