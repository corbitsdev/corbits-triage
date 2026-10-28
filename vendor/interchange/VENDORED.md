# Vendored Interchange

## Baseline

- Upstream: <https://github.com/faremeter/interchange>
- Stock ref: `19d89be64de634ea6e0ecfbfa7036d3ced6f8bef`
- Composite pin: stock `19d89be6` (`v0.5.0-103`) plus the local CL-10210
  carry, the INTR-666 adaptive-thinking model ids and Anthropic structured
  outputs, the host run-token routes, and the deployer's manage grant. Do not treat any
  delta as a new stock pin.
- Drift gate: `sh tooling/vendor-diff-check.sh`
- Health command: `bun run vendor:health`

The checkout is intentionally pruned, but includes the complete stock package
dependency closure needed by its declared workspaces. Upstream paths absent
from this checkout are informational in the drift gate only when they are
listed in `tooling/vendor-diff-pruned.txt`; any other absent path fails. Local
build artifacts and environment files are ignored; they are not vendor
patches. Tracked `.env*.example` templates are checked like any other file.

Re-vendoring: check out the stock ref and `rsync -a --delete` it over
`vendor/interchange`, excluding the pruned paths (`.env.sidecar`, `.git`,
`Makefile`, `apps/admin-ui`, `bin`, `bun.lock`, `bunfig.toml`, `db`, `docs`,
`eslint.config.ts`, `examples`, root `package.json`, `packages/inference-catalog`,
`packages/inference-discovery-*`, `skills`, `tsconfig.eslint.json`, every
`tests/*` except `tests/admin-ui-e2e/{harness,package.json,tsconfig.json}`),
`node_modules`, `*.tsbuildinfo`, `.DS_Store` and this file. Then re-apply the
allowed deltas and update the gate's default ref and the allowlist. A
re-vendor whose excluded paths change updates `tooling/vendor-diff-pruned.txt`.

## Allowed deltas

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
a dropped duplicate does not do, so the carry stays. Stock `19d89be6` changed
`workflow-run-kind.ts` and `supervisor.ts` in unrelated places, and the carry
applies to them unchanged.

The check also counts the mail a run's `RunStarted` records as its
`consumedMessageId`. A long-lived onTrigger run consumes its first trigger
only once it parks or ends, so the trigger sits in `processing/` while its
first event runs. Every recycle path that replays without owned message ids
(crash respawn and planned recycle) re-admits it, and a first trigger that
boot replay kept in `processing/` for its live run is re-admitted the same way
by a later recycle. The new child is re-driving the run, so dispatch waits until it parks and would then
redeliver the trigger as a new event; the run's work would run twice. The
carry consumes it instead. A test in `supervisor.test.ts` covers this case.

Allowed files:

- `packages/hub-sessions/src/workflow-run-kind.ts`
- `packages/hub-sessions/src/substrate.ts`
- `packages/workflow-host/src/supervisor/supervisor.ts`
- `packages/workflow-host/src/supervisor/supervisor.test.ts`

Upstream status: to be filed.

Remove when the stock pin consumes or skips a
replayed signal mail the run already recorded.

### Adaptive thinking for the Claude 5.5 models and Fable 5.1 (INTR-666)

Stock `ADAPTIVE_THINKING_MODELS` lacks `claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-haiku-5-5` and `claude-fable-5-1`, so the Anthropic adapter sends them
the classic `thinking: { type: "enabled", budget_tokens }` shape, which they
reject with `invalid_request_error` ("thinking.type.enabled is not supported
for this model"). The carry adds the four ids to the set, so thinking calls
use `thinking: { type: "adaptive" }` with `output_config.effort`. Opus 5.5
and Haiku 5.5 default to `medium` effort, so thinking on with no effort sends
no effort for them instead of the adapter's `high`. The
discovery plug-in's matching set lives in the pruned
`packages/inference-discovery-anthropic`, so only the runtime set is patched.

Allowed files:

- `packages/inference/src/providers/anthropic.ts`

Upstream reference: INTR-666.

Remove on the first bump whose stock set includes
the four ids.

### Anthropic structured outputs (INTR-666)

Stock `rejectUnsupportedResponseFormat` throws on every non-text
`responseFormat`, on the premise that Anthropic has no structured-outputs
surface. The Messages API now takes `output_config.format = { type:
"json_schema", schema }` (GA, no beta header). The carry maps `json-schema`
to that field, merged into any `output_config.effort` from adaptive thinking;
`name` and `strict` have no wire slot and are dropped. `json` with no schema
still throws, with a message that asks for a schema. The two
`responseFormat` boundary tests in `anthropic.test.ts` follow the change.

- The discovery support matrix
  (`packages/inference-discovery/src/catalog/support-matrix.ts`) still marks
  Anthropic structured output unsupported; nothing gates on it at runtime.
- With `strict` dropped, Anthropic always validates strictly: a schema using
  a keyword it does not support gets a 400.

Allowed files:

- `packages/inference/src/providers/anthropic.ts`
- `packages/inference/src/providers/anthropic.test.ts`

Upstream reference: INTR-666.

Remove when upstream's Anthropic adapter supports
structured outputs.

### Host run-token routes

Stock `createRunTokenAuth` refuses a workflow run token on every tenant route
outside the fixed `RUN_TOKEN_ROUTES`, and a host has no way to add one. The
carry lets the host list the Corbits hub routes a workflow run must reach.
`createApp` and `mountHubRoutes` take an optional `extraRunTokenRoutes`,
none by default, passed to `createRunTokenAuth` as `extraRoutes`, which
admits a run token on the stock list plus the extras with the same matching;
every other route is refused as before. Each extra must be a fixed path
under `/api/tenants/:tenantId/` with no other parameters, whose own handler
checks grants. `index.ts` also exports the `RunTokenRoute`
type so the host can type its list. One test in the `mountHubRoutes
composition` block of `app.test.ts` builds the hub with an extra: a run token
reaches the host route, a stock run-token route still reaches its own grant
check, and an unlisted route is still refused.

Allowed files:

- `packages/hub-api/src/middleware/run-token-auth.ts`
- `packages/hub-api/src/app.ts`
- `packages/hub-api/src/app.test.ts`
- `packages/hub-api/src/index.ts`

Upstream reference: none (not proposed upstream; tracked in CL-11373).

Remove when stock Interchange lets a host extend the run-token allowlist.

### Deployer manages the run it deployed

Stock `WorkflowAllocationService` grants the deploying principal only `read`
on `workflow-run:<anchorRunId>`, so a run that deploys another can watch it
but cannot stop it. The carry inserts that grant with `manage` instead; it is
the only changed line.

- `manage` also lets the deployer mail, signal and trigger the deployment.
  That deployment's runs carry the deployer's delegated grants and the
  definition creator's. This is no escalation: the deployer could get the
  same runs by deploying again.

Allowed files:

- `packages/hub-sessions/src/workflow-allocation-service.ts`

Upstream reference: none yet; to be raised upstream.

Remove when stock grants the deployer `manage` on the run it deployed.

## Dropped deltas

- Step-env director threading (PR #193 / INTR-581): stock `19d89be6` contains
  `401a8a58` (`Resolve referenced directors from workflow package slots`) and
  `4649da4e` (`Require a director registry for step and child environments`),
  so the step env and spawned-child deps resolve the closure's directors and
  `substrate-factory.ts` is stock again. The chain tests cover the built
  workflow packages' directors end to end.
- INTR-583 (operator-registered model-provider keys): stock `9ae47143`
  contains `5185df1a` (`Accept operator-registered provider plugins in the
  model catalog`), the merged form of `44170ebb`; the catalog files and
  `parse-row.test.ts` are stock again.
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
`tooling/vendor-health.test.ts`, which checks the operator model-provider key
against the vendored catalog.
