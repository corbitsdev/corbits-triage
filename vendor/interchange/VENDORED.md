# Vendored Interchange

## Baseline

- Upstream: <https://github.com/faremeter/interchange>
- Stock ref: `779b47f59c47026b14f02eb54eefa90e15b7fd9a`
- Composite pin: stock `779b47f5` plus allowlisted PR #193 at `13129bb5` (rebased), INTR-583 at `44170ebb`, and the local CL-10178 and CL-10210 carries. Do not treat any delta as a new stock pin.
- Drift gate: `sh tooling/vendor-diff-check.sh`
- Health command: `bun run vendor:health`

The checkout is intentionally pruned, but includes the complete stock package
dependency closure needed by its declared workspaces. Other paths absent from
this checkout but present upstream are informational in the drift gate. Local
build artifacts and environment files are ignored; they are not vendor
patches.

## Allowed deltas

### PR #193 custom-director support (INTR-581)

Required because `@corbits/triage-workflows` declares
`interchange.directors` and its agents reference
`@corbits/triage-workflows/triage`. Stock `779b47f5` only constructs the
built-in director registry, so that workflow cannot resolve its director at
runtime. The allowed production and regression files are upstream PR #193
commit `13129bb5b23df2dd11d0437fc2c2511f29ac6960` rebased onto the stock pin.
Upstream moved the sidecar child factory and probe into `@intx/workflow-host`
(`apps/sidecar/src/workflow-substrate-factory*.ts` became
`packages/workflow-host/src/child/substrate-factory.ts` and its tests;
`workflow-probe-handler.ts` became `packages/workflow-host/src/probe/index.ts`).
The rebase resolves only those conflicts: the factory imports the closure
loaders relatively, and `directors` sits beside the stock
`materializeStepTools` and child grant-cap deps. Makefile, docs, and `tests/`
paths from that PR are not in this prune and are not vendored.
`packages/workflow/src/definition/extract-agent.test.ts` is likewise absent
from the prune.

- `packages/agent/src/index.ts`
- `packages/agent/src/namespace.ts`
- `packages/agent/src/namespace.test.ts`
- `packages/tool-packaging/src/loader.test.ts`
- `packages/tool-packaging/src/loader.ts`
- `packages/workflow/src/definition/extract-agent.ts`
- `packages/workflow/src/definition/index.ts`
- `packages/workflow-deploy/src/capability-walk.ts`
- `packages/workflow-deploy/src/inert-ontrigger-bodies.ts`
- `packages/workflow-host/src/child/index.ts`
- `packages/workflow-host/src/child/run-child.ts`
- `packages/workflow-host/src/child/substrate-factory.ts`
- `packages/workflow-host/src/child/workflow-substrate-factory-abort.test.ts`
- `packages/workflow-host/src/child/workflow-substrate-factory-child-depth.test.ts`
- `packages/workflow-host/src/child/workflow-substrate-factory-child-grants.test.ts`
- `packages/workflow-host/src/child/workflow-substrate-factory-step-storage.test.ts`
- `packages/workflow-host/src/child/workflow-substrate-factory-suspendable-child.test.ts`
- `packages/workflow-host/src/index.ts`
- `packages/workflow-host/src/probe/index.ts`
- `packages/workflow-host/src/workflow-definition-loader.test.ts`
- `packages/workflow-host/src/workflow-definition-loader.ts`

Upstream reference: <https://github.com/faremeter/interchange/pull/193> at
`13129bb5b23df2dd11d0437fc2c2511f29ac6960`.

Kill date: **2026-11-01**. Remove this allowlist group as soon as the stock pin
contains PR #193; if it is not merged by the kill date, re-audit the dependency
and renew the date explicitly rather than silently carrying the patch.

### Operator-registered model-provider keys (INTR-583)

Required because `apps/hub/src/server.ts` registers and selects the
`corbits-system-one` adapter through `SIDECAR_ADAPTER_MANIFEST`, while stock
`779b47f5` restricts `ModelProviderPlugin` to its built-in enum. The catalog
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

### Run-scoped onTrigger body run ids (CL-10178)

Local carry, not upstream. Stock names each `onTrigger` body run
`<stepId>__<eventIndex>` with no parent run id, while the hub keys
`workflow_run` by run id globally. A second deployment of the same workflow
mints the same child id; the hub's lazy mint no-ops on the existing row, then
drops the child's terminal event because the row anchors to the first
deployment. The patch prefixes the child id with the container run id
(`<runId>__<stepId>__<eventIndex>`), matching loop bodies (`loopBodyRunId`),
and the crash-resume scan reads the same prefix. The two test files update
their child-id fixtures to the new shape.

Resume stays backward compatible with sections that span the upgrade: the
scan also recognizes the old `<stepId>__<eventIndex>` ids, takes the highest
event index across both forms, and re-drives an in-flight old-format body
under its durable old id. Every newly spawned body uses the run-scoped id.
`on-trigger-run.test.ts` covers an idle and an in-flight old-format resume.

Allowed files:

- `packages/workflow/src/runtime/run.ts`
- `packages/workflow/src/runtime/on-trigger-run.test.ts`
- `packages/workflow/src/runtime/on-trigger-tolerate-abort.test.ts`

Upstream status: to be filed.

Kill date: **2026-11-01**. Remove when the stock pin scopes onTrigger body
run ids to their container run.

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

## Dropped deltas

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
workflow. The stock tool-packaging and workflow-definition-loader fixtures
predate PR #193: one uses a now-rejected foreign director namespace and the
others omit the now-required definition argument. Their two test files are
therefore carried from the same PR and individually allowlisted above.
