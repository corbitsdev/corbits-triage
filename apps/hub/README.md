# @corbits/hub

The Corbits Triage hub: the stock Interchange hub plus Triage's composition (host webhook bridges, policy reads, custom
routes). In the image it also serves the built portal.

## Use

From the repository root, with `.env` set up as [DEV.md](../../docs/DEV.md) says:

```sh
bun run hub     # hub only; `bun run start` here does the same
bun run dev     # hub and portal
```

Every custom route is described in `/openapi.json`.

## Observability

`server.ts` configures observability once, before constructing the hub; `migrate.ts` does so before migrating. It uses stock `@intx/log` and
LogTape's supported advanced configuration API (a direct dependency). `createInterchangeHub()` does not reset logging.
Keep application call sites on `logJson`, passed as `log`; its local JSON lines retain `ts` and the existing fields.
Stock hub logs retain debug-level ANSI output outside production and info-level JSON in production. Application logs
stay JSON in both modes. Sidecars configure their own logging independently.

For an application-owned integration, pass arrays of async `(event, signal) => Promise<void>` destinations to
`configureObservability({ telemetry, errors, notifications }, { development })`. All three arrays and the boolean
logging mode are required and validated at startup. Use an explicit empty array to disable a role; missing arrays or
non-callable destinations are configuration errors, not disabled delivery. Both entry points explicitly supply three
empty arrays and derive the logging mode from validated `NODE_ENV`. No production provider, credentials, external-delivery
environment switches, Slack/email clients or Sentry clients are configured. Adapters must return promptly
and do asynchronous I/O, honor cancellation where possible, and must not perform blocking CPU work. JavaScript cannot
preempt blocking provider code. See [delivery and correlation limits](../../docs/ARCHITECTURE.md#hub-observability).

## Test

```sh
bun --conditions=intx-src test apps/hub
```

`*.postgres.test.ts` need a local Postgres ([DEV.md](../../docs/DEV.md#tests-and-typecheck)).

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- [IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md)
- [SELF_HOST.md](../../docs/SELF_HOST.md)
- [BITBUCKET_DATACENTER.md](../../docs/BITBUCKET_DATACENTER.md)
