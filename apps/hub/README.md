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

`server.ts` calls `await configureObservability()` once, before constructing the hub. It uses stock `@intx/log` and
LogTape's supported advanced configuration API (a direct dependency). `createInterchangeHub()` does not reset logging.
Keep application call sites on `logJson`, passed as `log`; its local JSON lines retain `ts` and the existing fields.
Stock hub logs use LogTape's JSON console formatter. Sidecars configure their own logging independently.

For an application-owned integration, pass arrays of async `(event, signal) => Promise<void>` destinations to
`configureObservability({ telemetry, errors, notifications })`. The default arrays are empty; no production provider,
credentials, environment switches, Slack/email clients or Sentry clients are configured. Adapters must return promptly
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
