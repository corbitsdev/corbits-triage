Follow the [root AGENTS.md](../../AGENTS.md).

- Env is read only in `src/env.ts`, validated there, and passed down as config.
- Every custom route is a Hono route described with hono-openapi (`describeRoute`) and arktype schemas.
- Log through the one JSON-line logger, `logJson` (`src/github/bridge.ts`), passed down as `log`.
- An action kind runs on its own when the `pr-triage` role holds `triage-do:<kind>:<source>:<owner/name>`; that rides in the trigger mail.
