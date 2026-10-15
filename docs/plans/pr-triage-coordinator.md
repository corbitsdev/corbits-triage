# Plan: pr-triage coordinator and per-triage worker deployments (CL-10705)

Status: design, no code; step 0 (spike) done, results in section 12. Paths are repository-relative; `vendor/` is the
vendored Interchange at stock `cd02c313` (`vendor/interchange/VENDORED.md`).
Upstream docs are cited by name at that ref.

## 1. Current flow and the bottleneck

```
GitHub/Bitbucket ─webhook─► bridge (apps/hub/src/github/bridge.ts)
                               │ accept()
                               ▼
                    coalescer (coalescer.ts) ── window per PR ──┐
reconciler (triage-reconciler.ts) ── batches of 5 heads ───────┤
held-do approval (held-dos) ───────────────────────────────────┤
                                                               ▼
              deliverToDeployment → ONE live deployment per tenant per host
              (server.ts:288-297, resolveLiveDeployment by workflow name)
                                                               │ mail
                                                               ▼
     pr-triage-github listener: onTrigger(mail) → body pr-triage-github-run
     (packages/triage-workflows/src/pr-triage.ts:16-27), on one sidecar
                                                               │
                         tenant observer reads that deployment's run log
                         → verdict table, triage-state rows
```

Bottleneck: `runOnTrigger` drives one body at a time. The loop at
`vendor/interchange/packages/workflow/src/runtime/run.ts:2906` awaits
`driveSuspendableOccurrence` (`run.ts:2941`, whose own `for (;;) await
child.next()` is at `run.ts:2664`) and only then re-arms its input park for the
next mail (`run.ts:2982`). So every mail to `pr-triage-github` waits for the
previous triage, judge calls included. Throughput is one triage at a time per
workspace per host, on one sidecar. Batching (`TRIAGE_BATCH_SIZE`, default 5,
`apps/hub/src/env.ts:138`) amortises it for catch-up only; live events go one
per mail (`coalescer.ts:152`).

Plain English: each workspace has one triage worker that handles pull requests
strictly one after another, so a burst of pull requests waits in a single line.

Side costs of the listener shape: its run log grows without bound, so the hub
rotates it (`deployment.ts:186-241`, `triage-reconciler.ts:310-345`); and a
failed listener stops all triage until healed (`triage-reconciler.ts:360-390`).

## 2. Target flow

```
webhook ─► bridge ─► coalescer (windows kept) ─┐
reconciler (catch-up, batches) ────────────────┼─► coordinator queue (hub)
approvals, backlog ────────────────────────────┘     │ capacity check
                                                     ▼
                         spawn worker deployment (one PR or a batch)
                         allocation.prepareProvisionedDeployment
                                                     │ provisioner selected by
                                                     │ tenant capabilities
                                                     ▼
                     sidecar (local process | Docker | E2B, reused or new)
                     worker = top-level run, fired once by mail, ends
                                                     │ terminal
                                                     ▼
          lifecycle releases capacity (capacityRetention.completed 0s)
          observer records the verdict from the worker's run log
          coordinator frees the slot and spawns the next
```

Stock Interchange (used as is):
- Deployment = one addressable top-level run; first trigger fires it; terminal
  runs cannot be fired again (upstream ARCHITECTURE.md, "A deployment owns one
  addressable top-level run", line 227).
- Mail fires that run: `POST /workflows/:runId/mail` "The first accepted
  message fires that run" (`vendor/interchange/packages/hub-api/src/routes/workflows.ts:676-700`);
  the hub uses the same path in-process (`runTriggerDeliverer`, `server.ts:286-290`).
- Deploy primitive: `WorkflowAllocationService.prepareProvisionedDeployment`
  (`vendor/interchange/packages/hub-sessions/src/workflow-allocation-service.ts:84-123`),
  already called from hub code by rotation (`deployment.ts:226`) and the
  portal's deploy route (`apps/hub/src/workflow-deploy.ts:68`).
- Lifecycle: `maxLifetime`, `capacityRetention.completed|failed|cancelled`,
  tenant `config.lifecycle` and per-definition overrides (upstream lifecycle.md
  lines 1-30, 60-94, 149-152).
- Placement: tenant `config.sidecarPlacement.capabilities`
  (`vendor/interchange/packages/db/src/tenant-hierarchy.ts:45-67`), workflow
  `sidecarPlacement`, provisioner `capabilities`, first-match chooser
  (`vendor/interchange/packages/hub-sessions/src/sidecar-allocation/plugin-registry.ts:36-118`,
  upstream SIDECAR_PLACEMENT.md "Tenant policy", "Selection").
- Reuse: a provisioner may answer `ensure` with a sidecar it already runs
  (`sidecar-allocation/contracts.ts:58-77`); at most 128 deployments per sidecar
  (`vendor/interchange/packages/types/src/sidecar.ts:48`).

Settled shape (owner, 2026-10-14): ONE coordinator for the hub, a hub module,
not one per tenant. It folds webhook events per (tenant, repository, pull
request) exactly as the coalescer does today; when a window closes it deploys
ONE fresh pr-triage deployment for that job. That deployment has ONE body run:
no trigger listener, its input is the folded mail, and the deployment is
released when the run ends. Capacity is the number of such deployments alive,
bounded by `TRIAGE_WORKERS_GLOBAL`, `TRIAGE_WORKERS_PER_TENANT` and
`TRIAGE_SPAWNS_PER_SECOND`.

Ours:
- Coordinator: the one hub module (section 3) owning queue, limits, priority,
  spawn.
- Worker definition: `prTriage({ sources })` changes from an `onTrigger`
  listener to a top-level run over the same `triageSteps`; one deployment,
  one run, one job.
- Recording: observer reads worker deployments instead of one listener log.
- Queue route for the portal (OpenAPI, arktype).
- Later, provisioners: Docker and E2B as `SidecarProvisioner` plugins.

## 3. Where spawning lives

(a) Coordinator workflow whose action step calls the hub deploy route.
- The hub REST resolves a principal only from a better-auth user session
  (`vendor/interchange/packages/hub-api/src/middleware/tenant.ts:26-77`;
  upstream AUTH.md "Request resolution flow"). The only non-session tokens are
  `itx_pat_`/`itx_svc_` git tokens, valid on smart-HTTP git routes only
  (AUTH.md "Smart-HTTP Git Tokens"; `middleware/git-token-auth.ts`). Our hub
  adds better-auth `bearer()`, which accepts a signed session token
  (`apps/hub/src/auth.ts:55,157`), still a user session.
- So (a) needs a long-lived user session token stored as a credential and
  delivered to the sidecar. That is a session used as an API key: not stock,
  expires, speaks as a person, and would sit in a sidecar. Also an action
  cannot reach a bound credential on this pin (AGENTS.md; `triage-steps.ts:23-25`),
  so the step would have to be a director, i.e. an agent wrapping a
  deterministic step, which AGENTS.md forbids.
- The coordinator workflow would itself be a long-lived `onTrigger` listener,
  serial again (section 1): it would bottleneck on spawn calls (each a probe,
  section 5) instead of on triage.
- Pro: the queue is a workflow, visible as runs. Con: a second copy of queue
  state the hub already holds (triage-state rows, coalescer windows).

(b) Hub coordinator module deploys workers directly.
- Deterministic hub code that already holds the queue (triage-state `queued`
  rows, `coalescer.ts:171-178`), the in-flight cap (`reconcile-plan.ts:282-303`)
  and the deploy primitive (`deployment.ts:226`). No new credential, nothing in
  a sidecar.
- Deploys as the principal that deployed the seed worker, checked the way the
  stock route would (`deployment.ts:186-224`, `mayDeploy`).
- Con: the coordinator is not a workflow, so it is not visible as runs; the
  portal sees it through a hub route instead.

Recommendation: (b). It keeps AGENTS.md: stock first (stock allocation,
lifecycle and placement; no vendored carry, no session-as-API-key), API first
(the queue is a documented hub route; workers are stock deployments listed by
the stock routes), and workflows for processes (each triage stays a workflow;
the coordinator is scheduling, not a process with steps). It is also the
simpler one: it reuses code that already runs in production and removes the
rotation and heal code. Revisit (a) only if upstream adds a tenant service
principal on REST routes.

## 4. Capacity and queueing

- Limits (hub config, `apps/hub/src/env.ts` only):
  `TRIAGE_WORKERS_GLOBAL` (all tenants on this hub, default 8 for the
  local-process provisioner), `TRIAGE_WORKERS_PER_TENANT` (default 4),
  `TRIAGE_SPAWNS_PER_SECOND` (probe pressure, default 2). Remote provisioners
  raise the global limit; a provisioner rejection with `retryable: true`
  (`contracts.ts:50-56`) shrinks it until the next success.
- Queue state: no new tables. A queued head is already a triage-state row with
  status `queued` (ARCHITECTURE.md "Data"); the in-memory coordinator holds
  only the ordering and the spawn slots. On restart the reconciler rebuilds it
  from those rows, as it does for lost coalescer windows today
  (`coalescer.ts:6-8`).
- Priority, highest first: approvals of held actions; live coalesced events;
  check-run re-triage; reconciler catch-up; backlog. Within a class, oldest
  first. Fairness: round-robin across tenants at the global limit.
- Back-pressure: when full, items stay queued; the coalescer keeps coalescing
  into its open window, so a waiting PR collapses to one spawn. A queued item
  whose head moved is replaced, not added (same key as `coalescer.ts:95-97`).
- Batching: live events one PR per worker; catch-up and backlog up to
  `TRIAGE_BATCH_SIZE` heads per worker, same repository, to amortise spawn cost.
- Dedupe kept: coalescer windows and `serialized` per PR stay; `inFlight`
  (`reconcile-plan.ts:222`) still stops a head being queued twice.
- Idle: a tenant with no queued work holds no worker deployments.
- Portal: `GET /api/integrations/github-triage/{tenantId}/queue` returns
  `{ queued: { approvals, live, catchUp, backlog }, running: [{ repo, number,
  headSha, runId, startedAt }], capacity: { tenant, global, used } }`; the
  repository panel shows queue depth and running count beside the verdicts.

## 5. Worker lifecycle

- One deployment per job, one run per deployment, released when the run ends:
  `prepareProvisionedDeployment` with the seed
  deployment's launch spec (source, entry, pin, offerings, deployer), as
  `createDeploymentRotation.redeploy` does today (`deployment.ts:209-241`).
- Fire: once the allocation is routable, the coordinator delivers the existing
  mail payload (`mailPayload`, `bridge.ts:167`) with `deliverToDeployment`.
  A `notReady` materialization already throws `DeploymentNotReadyError`
  (`deployment.ts:24-30`); the coordinator retries delivery with backoff up to
  the 2-minute first-connect window (lifecycle.md line 128).
- Definition: top-level run, `trigger: manual`, steps `triageSteps(...)`, same
  `credentialBindings` and `grantRequirements` (`pr-triage.ts:15-28` minus the
  `onTrigger` wrapper). The approval branch stays the first step.
- Lifecycle policy: tenant `capacityRetention.completed: "0s"`,
  `cancelled: "0s"`, `failed: "15m"`; worker definition override
  `maxLifetime: "1h"` (15-minute step timeouts with retries,
  `triage-steps.ts:5`). Set by the portal through the stock tenant PATCH and
  `PATCH .../workflows/definitions/:definitionId/lifecycle` (lifecycle.md
  lines 60-74). Today the portal sets `maxLifetime: 36500d` tenant-wide
  (`apps/web/src/lib/workflow-deploy.ts:82-96`); that moves to the listener
  definition only, while it exists.
- Failure: a failed or expired worker marks its heads `failed` with the run's
  error; the reconciler requeues by its existing attempts rule. No heal, no
  rotation: a broken worker affects one triage, not the tenant.
- Idempotency: unchanged. The same steps run with the same effect ids, so a
  respawned worker for the same head writes nothing already on GitHub.
- Recording: the observer reads worker deployments that are live or ended since
  the last pass, not the newest listener (`tenant-observer.ts:53-67`,
  `activeTenants`, `deployment.ts:93-112`, already supports `endedSince`). Each log holds one
  run, so reads are small. The verdict table and triage-state writes are
  unchanged (`triage-runs.ts`).
- Cost per spawn, local process today: one probe allocation (definition
  evaluated on a sidecar, `workflow-allocation-service.ts:562-620`), adopted
  as the deployment's sidecar because the same provisioner is in both lists
  (`server.ts:192-193`, adoption at `workflow-allocation-service.ts:715-719`),
  so one new sidecar process per triage, plus closure install and child ready
  (up to 30 s, lifecycle.md line 133). Not measured yet; step 0 measures p50/p95
  of deploy-to-first-step on the local stack. Expect seconds, against a triage
  of tens of seconds to minutes (judge calls).
- With a reusing provisioner: `ensure` answers with a warm sidecar of the same
  tenant and manifest digest (SIDECAR_PLACEMENT.md lines 83-127), skipping
  boot and install; the probe evaluation per deploy remains. Reuse must be
  per tenant: the stock sidecar does not isolate work it hosts.

## 6. Provisioner per workspace

- Provisioners register in `server.ts` (`sidecarProvisioners`,
  `probeSidecarProvisioners`, `server.ts:192-193`). Each declares capabilities;
  local process declares none (`apps/hub/src/sidecar/local-provisioner.ts:345-348`).
- Planned declarations: local process `runtime:local`; Docker
  `isolation:container`; E2B `isolation:workload`, `isolation:microvm`
  (capabilities name guarantees, not vendors, SIDECAR_PLACEMENT.md line 172).
  Order in the list is the default: local first while it is the only one.
- A workspace picks by stock tenant policy, `config.sidecarPlacement.capabilities`,
  e.g. `[{ capability: "isolation:workload", effect: "require" }]`, written
  through the stock `PATCH /api/tenants/:tenantId`. The portal shows it as a
  Sources-style "Where triage runs" setting with the options the hub offers;
  the hub lists them from its registry in a small read route. No custom store.
- A provider that needs a key (E2B) is a tenant credential like GitHub's, in the
  vault, delivered to the provisioner at ensure; never in the workflow.
- TanStack sandbox layer (unverified hypothesis, not in this repository): one
  provider interface over Docker, E2B and Daytona. One provisioner plugin on it
  gives every provider behind one `SidecarProvisioner`, with the provider
  chosen from the tenant's credential. Its value here is one plugin instead of
  one per vendor; the hub still sees only capabilities.

## 7. Migration

- Side by side: the worker is a new major version of the same packages
  (`pr-triage-github`, `pr-triage-bitbucket-datacenter`). The hub reads the
  newest deployment's workflow version from its launch spec
  (`deployment.ts:157-169`): listener version, mail as today; worker version,
  route through the coordinator. One switch, per tenant, per host.
- Cutover: portal publish deploys the worker version once (the seed; the hub
  fires it with the first queued item, or an empty batch that ends at once),
  then cancels the listener as it cancels superseded deployments today
  (`apps/web/src/lib/workflow-deploy.ts:120-127`). Heads queued in the
  listener's last window are requeued by the reconciler.
- Hook URLs unchanged: they end at the hub's `/api/hooks/*` and the bridge;
  the legacy `pr-triage` name keeps mapping (`source-workflow.ts:30-44`).
- Portal publish flow unchanged apart from the lifecycle settings in section 5
  and no longer keeping a listener alive.
- Rollback: publish the previous portal build; it deploys the listener version
  and the hub switches back by version. Worker deployments in flight finish.
- `pr-triage-historical` stays until backlog runs through the coordinator, then
  is deleted in its own PR.

## 8. Code changes

New
- `apps/hub/src/github/coordinator.ts`: priority queue, per-tenant and global
  slots, spawn and fire, slot release on terminal.
- `apps/hub/src/github/worker-spawn.ts`: spawn from the seed launch spec
  (moved from `createDeploymentRotation.redeploy`).
- `apps/hub/src/integrations/triage-queue-route.ts`: `GET .../queue`, OpenAPI.
- `apps/web/src/...`: queue depth and running count on the repository panel
  (TanStack Query over the route).

Changed
- `packages/triage-workflows/src/pr-triage.ts`: top-level manual run over
  `triageSteps`; no `onTrigger`.
- `apps/hub/src/github/coalescer.ts`: `flush` enqueues to the coordinator
  instead of `sendMail`.
- `apps/hub/src/github/triage-reconciler.ts`: delivers batches to the
  coordinator; rotation and heal removed.
- `apps/hub/src/github/tenant-observer.ts`, `triage-runs.ts`: observe worker
  deployments live or recently ended.
- `apps/hub/src/github/deployment.ts`: keep resolve and version reads; drop
  rotation.
- `apps/hub/src/github/source-workflow.ts`: seed deployment per host instead
  of a live listener.
- `apps/hub/src/server.ts`: wire the coordinator; approvals and backlog
  enqueue to it.
- `apps/hub/src/env.ts`: the three limits.
- `apps/web/src/lib/workflow-deploy.ts`: lifecycle settings; seed deploy.
- `docs/ARCHITECTURE.md`, `docs/SELF_HOST.md`: new flow and limits.

Deleted
- Rotation and heal paths (`deployment.ts:171-267`, `triage-reconciler.ts`
  rotation sections, `rotationKey` in tenant config handling).
- Later: `pr-triage-historical.ts` and its deploy.

Untouched: facts, rules, route, judge, parts, evaluate, mirror, execute,
approval (`triage-steps.ts`), directors, tools, credential bindings and
adapters, grants and `triage-do:` automation, policy resolution, effect ids,
verdict table, hook verification.

## 9. Tests and proof

- Acceptance: the CL-10688 load generator (synthetic bursts, recorded GitHub
  and Bitbucket responses, no real hosts), on one hub before and after.
- Local proof: throwaway hub, one tenant, 3 repositories, burst of 50 opened
  pull requests plus pushes and check completions; then 5 tenants in parallel.
- Report: time to verdict p50/p95, verdicts per minute, max queue depth,
  spawn latency p50/p95 (deploy to first step), sidecar count and hub/sidecar
  CPU and memory, failures and requeues, judge errors; listener vs workers at
  the same limits.
- Tests kept to load-bearing: one end-to-end hub test that a burst of N events
  produces N worker deployments under the per-tenant limit and N verdicts, and
  capacity is released; coordinator priority covered inside it.

## 10. Risks and open questions

- Does a mail fire a top-level run whose trigger is `manual`? The mail route
  says the first message fires the anchor run. Answer: prove it in step 0; if
  not, declare a `mail` trigger on the worker, no other change.
- Probe per spawn is the dominant fixed cost and stock always probes
  (`workflow-allocation-service.ts:562`). Answer: measure; batch catch-up;
  if it dominates, raise it upstream as an issue only when the owner asks.
- Local-process sidecars per hub: CPU and memory bound the global limit.
  Answer: default 8, sized from CL-10688 numbers.
- Seed deployment trust: spawning as the seed's deployer means a removed
  deployer stops triage. Answer: same rule as rotation today
  (`deployment.ts:217-224`); the portal reseeds on next visit and the queue
  route reports `deployer_inactive`.
- Hub is one replica (`coalescer.ts:10-11`, `tenant-observer.ts:11-14`); the
  coordinator is in process. Answer: acceptable now; durable state is the
  triage-state rows, so a restart loses only ordering.
- Run grants per worker: each deployment materializes grants at fire. Answer:
  unchanged path (`readyMaterializer`, `deployment.ts:24-30`).
- Sidecar sharing across tenants with a reusing provisioner. Answer: reuse only
  within a tenant; `isolation:workload` providers never share.
- Approvals racing a running triage on the same head. Answer: approvals take
  the highest priority but still wait for the head's in-flight worker, as the
  coalescer serialises per PR today.

## 11. Build plan

Each PR is one concern, small, behind the version switch until cutover.

0. Spike, no PR: done, section 12. Its blocker (12.4) is the gate for 2.
1. PR: worker definition, new major version of the per-host packages
   (30 min).
2. PR: worker observation in tenant observer and triage-runs (45 min).
3. PR: coordinator with limits, priority and spawn; coalescer, reconciler,
   approvals enqueue to it when the newest deployment is a worker (90 min).
4. PR: queue route and portal display (45 min).
5. PR: portal publish sets lifecycle and seeds workers; cancels the listener
   (30 min).
6. PR: delete rotation and heal once no tenant runs a listener (30 min).
7. PR: backlog through the coordinator; delete `pr-triage-historical` (45 min).
8. Separate issues: Docker and E2B provisioner plugins with capabilities, and
   the "Where triage runs" setting (CL-10687 dependency).

Proof after 3 and after 5: CL-10688 numbers, before and after.

## 12. Spike results (2026-10-14, local stack)

Setup: hub from this checkout (`bun --conditions=intx-src apps/hub/src/server.ts`,
Postgres `interchange` on 5432, fresh `HUB_DATA_DIR`,
`WORKFLOW_DEFAULT_RETENTION_COMPLETED=1s`), local-process sidecars. A throwaway
package `@spike/worker`: `defineWorkflow({ id, steps: { echo: action({ handler:
"echo", input: { from: "trigger.payload" } }) } })`, no `onTrigger`, no
`trigger` field, packed with `tooling/pack-tarball.ts`, published to a
package-registry asset and deployed through `POST
/api/integrations/workflow-deploy/:tenantId` (same `prepareProvisionedDeployment`
call as the stock route). Fired with `POST
/api/tenants/:t/workflows/:runId/mail` `{ content: "<job json>" }`.

### 12.1 Input delivery

- The pinned Interchange has no input field on deployment create: the stock
  route (`vendor/interchange/packages/hub-api/src/routes/workflows.ts:240-378`)
  and `PrepareProvisionedWorkflowDeploymentArgs`
  (`vendor/interchange/packages/hub-sessions/src/workflow-allocation-service.ts:84-102`)
  carry only `deployContent.systemPrompt`.
- The first mail is the run's input. The supervisor forwards the resolved
  `Mail` as `trigger.fire` with the message as the run's trigger payload
  (`vendor/interchange/packages/workflow-host/src/supervisor/supervisor.ts:3363-3385`);
  the child makes it `triggerPayload`
  (`vendor/interchange/packages/workflow-host/src/child/run-child.ts:1218-1258`);
  a definition without triggers snapshots it as `{ type: "manual", payload }`
  (`vendor/interchange/packages/workflow/src/runtime/run.ts:1307-1314`), so a
  step's `input: { from: "trigger.payload" }` reads it. Proven: the echo step
  ran on the mail body. Section 10's first question is answered: no `mail`
  trigger declaration is needed; declare none.

### 12.2 Timing, one sample (hub log and `workflow_run` row, run `run_7d12c7bd…`)

| point | wall clock | from deploy request |
| --- | --- | --- |
| deploy POST accepted (probe sidecar connected 54.800) | 02:46:54.3 | 0 |
| anchor `deployed` (sidecar "Deployed …") | 02:46:55.622 | 1.3 s |
| mail accepted, run fired | 02:46:55.698 | 1.4 s |
| run `completed` (`ended_at`) | 02:46:55.787 | 1.5 s |
| allocation `released`, sidecar disconnected | 02:46:58.25 | 4.0 s |

The run started 1.4 s and the deployment was released 4.0 s after the deploy
request, with `capacityRetention.completed` at 1 s (`capacity_release_at` =
`ended_at` + 1 s). Five samples were not collected: the harness waited on
`GET /workflows/runs/:runId` to report `completed`, which never happened (12.4).
The earlier sample (`run_556f2ff6…`) reached `deployed` 0.6 s after its deploy
request. The probe sidecar is adopted as the deployment's sidecar, so one
process per worker; `local-sidecars/<allocation>` is created per deploy.

### 12.3 Internal routes

- Create: `WorkflowAllocationService.prepareProvisionedDeployment`
  (`workflow-allocation-service.ts:84-123`), the function the stock deploy
  route calls (`routes/workflows.ts:309-323`); the hub already calls it
  in-process from `createDeploymentRotation.redeploy`
  (`apps/hub/src/github/deployment.ts:226-239`) and `apps/hub/src/workflow-deploy.ts:68`.
  No HTTP, no session: the principal is a parameter
  (`sourceAuthorityPrincipalId`), checked by `mayDeploy` as the route would.
- Fire: `createRunTriggerDeliverer` from `@intx/hub-sessions`, built in
  `apps/hub/src/server.ts:220-231` with the mail-triggered grants materializer
  and used for cron and for every triage mail today
  (`deliverToDeployment`, `server.ts:288-290`). In-process, system sender,
  no session. The HTTP mail route is the same path behind a session
  (`routes/workflows.ts:676-729`).
- Option (b) stands: both calls exist in-process and are already in production
  hub code. No session-as-API-key is needed.

### 12.4 Blocker: the one-run deployment's final log push is rejected

Observed on the sample: 114 ms after the run's `ended_at`, the sidecar pushed
the run log pack and the hub refused it twice: `Workflow-run pack rejected for
run_7d12…: source address has no live deployment anchor`, reported to the
sidecar as `path_violation`. The check is
`vendor/interchange/packages/hub-sessions/src/hub-session-lookups.ts:348-373`:
a workflow-run pack is accepted only while the anchor row is in a live status.
When the top-level run is the anchor, its terminal status (projected from the
control frame) lands before the pack carrying its terminal events, so the
events never reach the hub repository: `hub-data/workflow-runs/<run>` holds
only `.git` and `.gitignore`, `GET /workflows/runs/:runId` stays at the event
collector's last state, and the run's events route is empty.

Consequence: the plan's recording path (observer reads each worker's run log,
sections 2 and 5) has nothing to read. Unverified hypothesis: the listener
shape never hits this because its anchor stays live across body runs; it is
specific to a top-level run that ends. Reproduced once; needs reproducing on
a second deploy and on the listener shape before it is filed upstream.
Options, in order: (1) check whether an earlier pack (step events before the
terminal one) is accepted and only the terminal pack is lost, which would
still break verdict recording; (2) a stock retention or ordering setting that
holds the anchor live until the pack lands; (3) raise upstream when the owner
asks (`feedback-no-upstream-interchange`). Until resolved, step 2 of the build
plan (worker observation) is blocked; steps 1 and 3 are not.

### 12.5 Credential and grants in this shape

Unchanged from the listener. The materializer in the fire path
(`createMailTriggeredRunGrantsMaterializer`,
`vendor/interchange/packages/hub-api/src/run-grant-materialization.ts:777-830`)
derives the run's grants from the receiving deployment's frozen snapshot and
the anchor's resolved credential-binding grants, per deployment, at first
fire; `readyMaterializer` (`apps/hub/src/github/deployment.ts:24-30`) throws
`DeploymentNotReadyError` until credential resolution is published. The
worker definition keeps `credentialBindings` and `grantRequirements`
(`packages/triage-workflows/src/pr-triage.ts:22-23`), so each worker
deployment binds the host credential itself and the `triage-do:` grants ride
in the mail as today. Nothing new is needed; the cost is one grant
materialization per worker instead of per listener.
