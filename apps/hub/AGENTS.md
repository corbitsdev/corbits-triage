# Hub

- Env is read only in `src/env.ts`, validated there, and passed down as config.
- Every custom route is a Hono route described with hono-openapi (`describeRoute`) and arktype schemas, merged into `/openapi.json`.
- Log through the one JSON-line logger, `logJson` (`src/github/bridge.ts`), passed down as `log`.
- `*.postgres.test.ts` tests need a local Postgres.
- Whether an action kind runs on its own is read from the `pr-triage` role's grants (`triage-do:<kind>:<owner/name>`) and rides in the trigger mail.
