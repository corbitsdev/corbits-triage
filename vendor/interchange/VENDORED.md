# Vendored Interchange

## Baseline

- Upstream: <https://github.com/faremeter/interchange>
- Stock ref: `74c57b39bc9613ab38ae8eab73af743797d589e2`
- Composite pin: stock `74c57b39` plus INTR-583 at `44170ebb` and the local CL-10210 and CL-10211 carries. Do not treat any delta as a new stock pin.
- Drift gate: `sh tooling/vendor-diff-check.sh`
- Health command: `bun run vendor:health`

The checkout is intentionally pruned, but includes the complete stock package
dependency closure needed by its declared workspaces. Other paths absent from
this checkout but present upstream are informational in the drift gate. Local
build artifacts and environment files are ignored; they are not vendor
patches.

## Allowed deltas

### Operator-registered model-provider keys (INTR-583)

Required because `apps/hub/src/server.ts` registers and selects the
`corbits-system-one` adapter through `SIDECAR_ADAPTER_MANIFEST`, while stock
`74c57b39` restricts `ModelProviderPlugin` to its built-in enum. The catalog
files are byte-identical to upstream commit
`44170ebbcf819e1f48e0ec4c7a0d9f682635d10d`
(`Accept operator-registered provider plugins in the model catalog`) on
branch `intr-583-allow-operator-registered-custom-model-provider-types-in-the`
(tip `2d815607`). `packages/db/src/parse-row.test.ts` carries that commit's
change on top of the stock pin's newer run-row fixture fields. This is the
open operator-plugin grammar, not a one-key enum poke. `apps/admin-ui` and
`docs/` from that commit are not in this prune and are not vendored.

Allowed files:

- `packages/types/src/catalog.ts`
- `packages/types/src/catalog.test.ts`
- `packages/db/src/schema/catalog.ts`
- `packages/db/src/parse-row.test.ts`

Upstream reference: <https://github.com/faremeter/interchange/commit/44170ebb>.

Kill date: **2026-11-01**. Remove this delta when the stock pin contains
`44170ebb` (or its merged equivalent); if it is still absent at the kill date,
re-audit and renew explicitly.

### Consume signal mail the run already recorded (CL-10210)

Local carry, not upstream. A signal mail can stay in `processing/` after the
run recorded it: a restart between the run's `SignalReceived` and
`markConsumed`, or a failed dispatch. Boot replay re-admits it (only
`RunStarted` message ids count as owned), the supervisor re-sends it, the
child drops the duplicate without re-parking, the terminal-or-park backstop
fails the dispatch, and that mail and every newer one stay unconsumed. The
patch makes `dispatchOne` consume a mail whose message id the run log already
records as a `SignalReceived`, without redelivering it or dropping the run's
input channel. `hasRecordedSignal` reads the run's event log for that check.

Allowed files:

- `packages/hub-sessions/src/workflow-run-kind.ts`
- `packages/hub-sessions/src/substrate.ts`
- `packages/workflow-host/src/supervisor/supervisor.ts`

Upstream status: to be filed.

Kill date: **2026-11-01**. Remove when the stock pin consumes or skips a
replayed signal mail the run already recorded.

### Keep a reconnect-cancelled pack push from failing the next write (CL-10211)

Local carry, not upstream. When the sidecar's hub link cycles on reconnect it
cancels in-flight pack pushes with "Connection lost". The pack-pushing store
latched that like a receiver rejection and threw it on the deployment's next
local write before committing, so a write landing between the cancel and the
reconnect re-drive (in production, `markConsumed` 90 ms later) failed, the
mail stayed in `processing/`, and the deployment idled. The patch keeps the
slot dirty for the re-drive instead of throwing when the latched error is the
disconnect cancel; receiver rejections still surface on the next write.

Allowed files:

- `packages/workflow-host/src/deploy/workflow-run-pack-client.ts`

Upstream status: to be filed.

Kill date: **2026-11-01**. Remove when the stock pin no longer surfaces a
reconnect-cancelled push as a local write failure.

## Dropped deltas

- PR #193 / INTR-581 (custom directors): stock `74c57b39` loads the workflow
  package's own `interchange.directors` in
  `packages/workflow-host/src/workflow-definition-loader.ts`, which is where
  `@corbits/triage-workflows` ships its director.
- CL-10178 (run-scoped onTrigger body run ids): stock `74c57b39` contains
  `ff4539ed` and `786c5039`, which mint `<runId>__<stepId>__<eventIndex>` and
  resume bodies recorded under the old `<stepId>__<eventIndex>` id.
- INTR-647 (tool-scoped credential grants in spawned children): stock
  `779b47f5` contains `26f2e755` (`Keep a child credential grant for a tool
  the child instantiates`), which keeps a `credential:` allow whose `{ tool }`
  condition names a factory the child body instantiates. The cap now lives in
  `packages/workflow-deploy/src/child-grant-filter.ts`.

## Reverted historical drift

On 2026-10-02 the following local changes were removed and restored to stock
`9febf699` bytes:

- all 18 package-manifest dependency/export rewrites; stock `intx-src`
  conditional exports are now selected by repository launch/build/test
  commands instead of changing vendor manifests. Eleven previously pruned
  stock workspace dependencies (`authz`, `crypto`, `hub-api`, `hub-common`,
  `hub-sessions`, `inference-discovery`, `inference-testing`, `log`,
  `pack-transport`, `tools-lsp`, and `tools-posix`) were restored byte-for-byte
  so `bun install` can resolve the stock `workspace:*` declarations;
- `apps/hub/src/send-otp-email.ts` and its test, which had no repository
  consumer and no upstream provenance;
- `.claude/settings.local.json`, a local editor/agent setting;
- the earlier OpenAI null-delta tolerance patch. That accommodation remains
  outside vendor in `@corbits/openai-null-delta`.

No directory wildcard is allowlisted. Every permitted drift file is listed
individually in `tooling/vendor-diff-allowlist.txt`.

The health command enables `intx-src`, runs the catalog, tool-packaging,
workflow-deploy, and workflow-definition-loader suites, and runs
`tooling/vendor-health.test.ts` against this repository's real custom
workflow.
