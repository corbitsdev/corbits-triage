# Vendored Interchange

## Baseline

- Upstream: <https://github.com/faremeter/interchange>
- Stock ref: `9ae471437453db9ef1af1eca6d94c524cecf05f1`
- Composite pin: stock `9ae47143` (upstream main on 2026-10-15) plus the
  step-env director threading from PR #193 and the local CL-10210 carry. Do
  not treat any delta as a new stock pin.
- Drift gate: `sh tooling/vendor-diff-check.sh`
- Health command: `bun run vendor:health`

The checkout is intentionally pruned, but includes the complete stock package
dependency closure needed by its declared workspaces. Other paths absent from
this checkout but present upstream are informational in the drift gate. Local
build artifacts and environment files are ignored; they are not vendor
patches. Tracked `.env*.example` templates are checked like any other file.

Re-vendoring: check out the stock ref and `rsync -a --delete` it over
`vendor/interchange`, excluding the pruned paths (`.env.sidecar`, `.git`,
`Makefile`, `apps/admin-ui`, `bin`, `bun.lock`, `bunfig.toml`, `db`, `docs`,
`eslint.config.ts`, `examples`, root `package.json`, `packages/inference-catalog`,
`packages/inference-discovery-*`, `skills`, `tsconfig.eslint.json`, every
`tests/*` except `tests/admin-ui-e2e/{harness,package.json,tsconfig.json}`),
`node_modules`, `*.tsbuildinfo`, `.DS_Store` and this file. Then re-apply the
allowed deltas and update the gate's default ref and the allowlist.

## Allowed deltas

### Step-env director threading (upstream PR #193)

Required because `@corbits/triage-workflows` ships its director through its
own `interchange.directors`. Stock loads that registry into the
run-child's runtime env, but `createSidecarStepBuildEnv` still hardcodes
`createDefaultDirectorRegistry()`, so every step naming
`@corbits/triage-workflows/triage` fails at build with
`UnknownDirectorIdError`. The carry resolves the step env's registry from
`closurePackageDir` (memoised, built-ins when absent) and passes the same
closure registry to spawned-child deps, whose grant cap otherwise drops the
`director:` grant of every onTrigger body step (kept for consistency with the
approved snapshot; not re-gated at runtime on this pin). It takes only this threading
from upstream PR #193 (head `94bbf8c2`, open); not its dependency-package
director loading or namespace changes. `tooling/vendor-health.test.ts`
asserts the step env resolves the director.

Allowed files:

- `packages/workflow-host/src/child/substrate-factory.ts`

Upstream reference: <https://github.com/faremeter/interchange/pull/193>.

Kill date: **2026-11-01**. Remove when upstream's step env loads the closure
registry.

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
Stock `cb0bdfb4` stops the child appending a duplicate `SignalReceived`, but
`dispatchOne` still redelivers the mail and waits for the run to park, which
a dropped duplicate does not do, so the carry stays. The three files are
unchanged upstream between `cd02c313` and `9ae47143`, so the carry applies
as-is.

Allowed files:

- `packages/hub-sessions/src/workflow-run-kind.ts`
- `packages/hub-sessions/src/substrate.ts`
- `packages/workflow-host/src/supervisor/supervisor.ts`

Upstream status: to be filed.

Kill date: **2026-11-01**. Remove when the stock pin consumes or skips a
replayed signal mail the run already recorded.

## Dropped deltas

- INTR-583 (operator-registered model-provider keys): stock `9ae47143`
  contains `5185df1a` (`Accept operator-registered provider plugins in the
  model catalog`), the merged form of `44170ebb`; the catalog files and
  `parse-row.test.ts` are stock again.
- The rest of PR #193 / INTR-581 (dependency-package directors, owned-id
  namespace checks, the definition-scoped loader): stock already loaded the
  workflow package's own `interchange.directors` into the runtime env, which
  is all `@corbits/triage-workflows` needs. Only the step-env threading above
  is still carried.
- CL-10178 (run-scoped onTrigger body run ids): stock `74c57b39` contains
  `ff4539ed` and `786c5039`, which mint `<runId>__<stepId>__<eventIndex>` and
  resume bodies recorded under the old `<stepId>__<eventIndex>` id.
- INTR-647 (tool-scoped credential grants in spawned children): stock
  `779b47f5` contains `26f2e755` (`Keep a child credential grant for a tool
  the child instantiates`), which keeps a `credential:` allow whose `{ tool }`
  condition names a factory the child body instantiates. The cap now lives in
  `packages/workflow-deploy/src/child-grant-filter.ts`.
- CL-10211 (reconnect-cancelled pack push failing the next write): stock
  `cd02c313` contains `678c336b` (`Keep a disconnected workflow history push
  pending for recovery`), which leaves a disconnected push due for recovery
  without poisoning the next write.

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
