# Plan: pr-triage coordinator and per-triage worker deployments (CL-10705)

Status: step 0 (spike) done, results in section 12; 12.4 reproduced and decided (12.6); step 1 built behind `TRIAGE_COORDINATOR`; step 2 (worker observation) built, proof in 12.8. Paths are repository-relative; `vendor/` is the
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
                spawn worker deployment: a copy of the live listener,
                marked a worker in its deploy content
                (rotation's redeploy → allocation.prepareProvisionedDeployment)
                                                     │ provisioner selected by
                                                     │ tenant capabilities
                                                     ▼
                     sidecar (local process | Docker | E2B, reused or new)
                     worker = the listener definition, fired with one mail;
                     its one body run is a child of the anchor
                                                     │ body run terminal
                                                     ▼
          coordinator requests cancellation of the worker's anchor
          lifecycle releases capacity (capacityRetention.cancelled 0s)
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
  already called from hub code by rotation (`deployment.ts`, `redeploy`) and the
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

Settled shape (owner, 2026-10-14; worker shape 12.6): ONE coordinator for the
hub, a hub module, not one per tenant. It takes the mail the coalescer folds
per (tenant, repository, pull request); when a window closes it deploys ONE
fresh pr-triage deployment for that job. That deployment is today's listener
definition, `onTrigger({ body: perPr })`, fired with exactly that one mail, so
it runs ONE body run; the deployment is released when that run ends. Capacity
is the number of such deployments alive, bounded by `TRIAGE_WORKERS_GLOBAL`,
`TRIAGE_WORKERS_PER_TENANT` and `TRIAGE_SPAWNS_PER_SECOND`.

Ours:
- Coordinator: the one hub module (section 3) owning queue, limits, priority,
  spawn.
- Worker: no definition change. The worker is a copy of the live listener,
  told apart by a marker in its deploy content (section 5), so nothing that
  looks for "the live deployment" mails or rotates a worker.
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
  `createDeploymentRotation.redeploy` with the seed listener's launch spec
  (source, entry, pin, offerings, deployer), plus `corbitsTriageWorker: true`
  in the copy's deploy content (`apps/hub/src/github/deployment.ts`,
  `WORKER_MARKER`). The marker is read back from the launch spec row, so a
  worker is told from a listener without a table of its own.
- Seed: the newest live listener of the workflow. `resolveLiveDeployments`
  returns listeners unless workers are asked for, so the seed, the
  reconciler's rotation and adoption, `sendBridgeMail`, held actions and the
  portal's deployment list never see a worker; only the spawner's fire and
  wait look workers up.
- Fire: once the copy is routable, the spawner delivers the coalescer's mail
  payload (`mailPayload`, `bridge.ts`) with `deliverToDeployment`. A `notReady`
  materialization throws `DeploymentNotReadyError` (`deployment.ts`); the
  spawner retries delivery up to the 2-minute first-connect window
  (lifecycle.md line 128), then cancels the copy and fails the head.
- Capacity refusal: a `prepareProvisionedDeployment` rejected for capacity
  (`WorkflowProvisioningError`, code `capacity_unavailable`) is a retry, not a
  failure: the job goes back on the queue with a doubling wait between
  `TRIAGE_RETRY_MS` and `TRIAGE_RETRY_MAX_MS`.
- End: the body run, a child of the anchor, leaves the live `workflow_run`
  statuses (or the anchor does, read through `lifecycle.getStatus`), polled
  every 2 s. Then `lifecycle.requestCancellation` on the anchor, always, even
  when the wait itself failed.
- Definition: unchanged, `prTriage({ sources })` with its `onTrigger` wrapper,
  `credentialBindings`. The approval branch stays the
  first step.
- Lifecycle policy: tenant `capacityRetention.cancelled: "0s"`,
  `completed: "0s"`, `failed: "15m"`; worker `maxLifetime` is the listener's
  until step 5 sets the lifecycle at publish (`PATCH
  .../workflows/definitions/:definitionId/lifecycle`, lifecycle.md lines 60-74).
- Same pull request again while its worker runs: the newer job waits in the
  queue until that worker ends, then spawns; the reconciler's supersede rule
  retires the older run's result.
- Restart: the queue is in process. On start the hub releases every live
  deployment carrying the worker marker (`releaseOrphanedWorkers`), logged;
  their heads are `queued` rows the reconciler picks up.
- Failure: a failed or expired worker marks its heads `failed` with the run's
  error; the reconciler requeues by its existing attempts rule. No heal, no
  rotation: a broken worker affects one triage, not the tenant.
- Idempotency: unchanged. The same steps run with the same effect ids, so a
  respawned worker for the same head writes nothing already on GitHub.
- Recording: the observer reads worker deployments that are live or ended since
  the last pass, not the newest listener (`tenant-observer.ts:53-67`,
  `activeTenants`, `deployment.ts`, already supports `endedSince`). Each log holds one
  run, so reads are small. The verdict table and triage-state writes are
  unchanged (`triage-runs.ts`).
- Cost per spawn, local process today: one probe allocation (definition
  evaluated on a sidecar, `workflow-allocation-service.ts:562-620`), adopted
  as the deployment's sidecar because the same provisioner is in both lists
  (`server.ts:192-193`, adoption at `workflow-allocation-service.ts:715-719`),
  so one new sidecar process per triage, plus closure install and child ready
  (up to 30 s, lifecycle.md line 133). Measured in 12.2.
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

0. Spike, no PR: done, section 12. Its blocker (12.4) is decided in 12.6.
1. PR: coordinator skeleton behind `TRIAGE_COORDINATOR` (off by default):
   queue, limits, spawn from the live listener, release on run end; the
   coalescer enqueues to it when on. Built, section 12.6. No worker
   definition change: the worker is the listener definition (12.6), marked
   `corbitsTriageWorker` in its deploy content and hidden from every live
   deployment lookup but the spawner's; on start the hub releases workers a
   restart orphaned (section 5).
2. PR: worker observation in the tenant observer (45 min). Built, section
   12.8: the observer reads worker deployments live or released within two
   reconciler intervals (`recentWorkers`, `deployment.ts`) after the
   listeners, so the reconciler and the recording pass see a worker's one run
   exactly as a listener's; rotation, mail and the portal's deployment list
   still see listeners only.
3. PR: every triage mail through the coordinator and the queue route. Built,
   sections 12.9 and 12.10: one `sendTriageMail(job)` in the hub for the
   coalescer, the retry route and the reconciler; each job names its `source`
   (`event`, `retry`, `reconcile`), the reconciler sends one head per job when
   the coordinator is on, and `GET /api/integrations/triage-queue/{tenantId}`
   lists the workspace's queued and running jobs. The coordinator handles
   inbound triage and spawns runs, nothing else: approvals and backlog still
   mail their listeners, since anything that waits on a person belongs to
   pr-triage. No priority classes: one queue, oldest first.
4. PR: portal display of the queue route (30 min).
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

Reproduced four more times (2026-10-14, same stack, fresh `HUB_DATA_DIR` each hub start), two with the echo step returning at once and two with the step sleeping 5 s, so the run outlives any push debounce:

| hub retention | step | run | `ended_at` | first pack rejection | rejections | `capacity_release_at` | DB status | `GET …/runs/:id` status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1s | immediate | `run_9fefb780…` | 02:55:05.481 | 02:55:05.639 (+158 ms) | 1 | 02:55:06.481 | completed | stopped |
| 1s | immediate | `run_633652ce…` | 02:55:26.631 | 02:55:26.763 (+132 ms) | 2 | 02:55:27.631 | completed | stopped |
| 30s | 5 s sleep | `run_c026511b…` | 02:56:42.657 | 02:56:42.722 (+65 ms) | 3 | 02:57:12.657 | completed | stopped |
| 30s | 5 s sleep | `run_ffee8826…` | 02:57:25.121 | 02:57:25.188 (+67 ms) | 3 | 02:57:55.121 | completed | stopped |

Log lines, every run the same pair (hub then sidecar):

```
WRN hub·lookups: Workflow-run pack rejected for 'run_c026511b2026be283aa0c82c7eb62b90-spike-mv8y6chn-localhost': source address has no live deployment anchor
WRN interchange·sidecar·workflow-run-pack-client: workflow-run pack push failed for deployment 'run_c026511b2026be283aa0c82c7eb62b90-spike-mv8y6chn-localhost' ('run_c026511b2026be283aa0c82c7eb62b90@spike-mv8y6chn.localhost'): …
```

Findings:
- Every pack is lost, because there is only one: with the step sleeping 5 s, no pack was pushed during the run; the first push came 65 ms after `ended_at` and was refused. The pack client coalesces local commits into one push, and for this shape the first push carries the whole log, terminal events included. No pack ever landed: `hub-data/workflow-runs/<run>` holds only `.git` and `.gitignore` in all four cases.
- Not a retention race: `WORKFLOW_DEFAULT_RETENTION_COMPLETED=30s` changes nothing. The refusal comes 65 to 158 ms after `ended_at`, 1 s to 30 s before `capacity_release_at`. The anchor check in `hub-session-lookups.ts:348-373` tests the row's status (`deployed`/`running`), not its retention, and the terminal status is projected from the control frame before the pack arrives.
- The hub run row does reach `completed` in `workflow_run` (`ended_at` set, `capacity_release_at` = `ended_at` + retention, allocation `released` on time). The stock run read route reports `stopped` for the same run throughout, and the run's events route serves the event collector's `RunStarted, StepStarted, StepCompleted, RunCompleted` for all four, so the status and events the portal reads are available; only the run-log repository, which the observer reads today, is empty.
- Upstream head does not change this (`hub-session-lookups.ts` identical; upstream PR #227 hardens "terminal anchor rejects later receives"), so it is by design, not a bug to file. No retention setting makes the worker's own pack land.

### 12.6 Decision: the worker keeps the listener shape

Settled 2026-10-14, on the current pin, no bump. The worker is today's definition, `onTrigger({ body: perPr })`, deployed fresh per job and fired with exactly one mail. The body run is a child of the anchor, so its pack lands while the anchor stays `running`; the coordinator sees the body run end (the stock `workflow_run` row of the child leaves the live statuses) and calls `lifecycle.requestCancellation` on the anchor, the call rotation uses today (`apps/hub/src/github/deployment.ts`, `release`). One deployment, one run, released on end: the owner's shape holds without a top-level run and without an upstream change. The observer path (step 2) reads these body runs exactly as it reads listener body runs today, so step 2 is no longer blocked; it is not in step 1's PR.

What this changes in the plan: section 2's "no trigger listener" and section 5's "Definition: top-level run, `trigger: manual`" are replaced by this shape; the `prTriage({ sources })` definition does not change for step 1 and no new package major is needed. 12.1 stands for the record (a top-level run reads mail as `trigger.payload`), but it is not used.

Step 1 as built (`TRIAGE_COORDINATOR=on`, off by default so the listener path is untouched):
- `apps/hub/src/github/coordinator.ts`: the queue, keyed per (tenant, repository, pull request) so a newer job replaces a queued one; global and per-tenant worker caps; spawn spacing from `TRIAGE_SPAWNS_PER_SECOND`; round-robin across tenants at the cap; the slot is held through the spawn and released when the worker's run has ended. The per-pull-request fold stays the coalescer's, unchanged: the coordinator takes the mail it would have sent.
- `apps/hub/src/github/worker-spawn.ts`: the seed is the host's live pr-triage deployment; the copy is `createDeploymentRotation.redeploy` (the `prepareProvisionedDeployment` call the spike used); fire is `deliverToDeployment` retried on `DeploymentNotReadyError` within the two-minute first-connect window; end is the child run leaving the live statuses (or the anchor leaving them); release is `requestCancellation`.
- `apps/hub/src/env.ts`: `TRIAGE_COORDINATOR`, `TRIAGE_WORKERS_GLOBAL`, `TRIAGE_WORKERS_PER_TENANT`, `TRIAGE_SPAWNS_PER_SECOND`.
- Known limits of the skeleton, for steps 2 and 3: the reconciler, approvals and backlog still mail the listener; the queue is not yet a route.

### 12.5 Credential and grants in this shape

Unchanged from the listener. The materializer in the fire path
(`createMailTriggeredRunGrantsMaterializer`,
`vendor/interchange/packages/hub-api/src/run-grant-materialization.ts:777-830`)
derives the run's grants from the receiving deployment's frozen snapshot and
the anchor's resolved credential-binding grants, per deployment, at first
fire; `readyMaterializer` (`apps/hub/src/github/deployment.ts:24-30`) throws
`DeploymentNotReadyError` until credential resolution is published. The
worker definition keeps `credentialBindings`
(`packages/triage-workflows/src/pr-triage.ts:23`), so each worker
deployment binds the host credential itself and the `triage-do:` grants ride
in the mail as today. Nothing new is needed; the cost is one grant
materialization per worker instead of per listener.

### 12.7 Live proof of step 1 (2026-10-14, local stack)

Setup: hub from this checkout on a fresh database, `TRIAGE_COORDINATOR=on`,
`TRIAGE_WORKERS_GLOBAL=1`, `TRIAGE_WORKERS_PER_TENANT=1`,
`TRIAGE_RECONCILE_INTERVAL_MS=30000`, tenant lifecycle `capacityRetention`
`completed`/`cancelled` `0s`; local Bitbucket Data Center (Docker) with
TRI/widgets enabled through the hub routes, a two-rule deterministic policy
(`no-merge-conflicts`, `max-files-changed`), a placeholder decision-model
credential (no judge call is made by this policy), and the webhook created on
the instance by hand because the service token cannot manage webhooks. Each
scenario pushes a commit to the branch of TRI/widgets#20; the wait for
`worker_spawned` in the hub log decides when the mid-worker action fires.

(a) One commit, pass. Push accepted 03:31:03.0; the hook was queued at
03:31:03.265; the coalescer's 3 s window closed and the worker anchor row was
created at 03:31:07.570 (`workflow_run_launch_spec.deploy_content ->>
'corbitsTriageWorker' = 'true'`); the sidecar reported `Deployed
'run_e54cb687…@proof-….localhost' generation '0'` at 03:31:09.846; the one
mail was accepted on the first delivery:

```
{"msg":"worker_spawned","tenantId":"tnt_bc3681ef…","repo":"bitbucket-datacenter:TRI/widgets","pr":20,"workflow":"pr-triage-bitbucket-datacenter","runId":"run_e54cb6871cf48f724e6e120329b894e6"}   03:31:11.640
inbound mail signature verdict 'valid'/'match' for 'github@proof-….localhost'   03:31:11.643
{"msg":"worker_ended",…,"runId":"run_e54cb6871cf48f724e6e120329b894e6"}   03:31:13.653
```

The body run `run_e54cb687…__events__0` completed at 03:31:12.578; the anchor
is `cancelled` with `ended_at` 03:31:14.478; `sidecar_allocation` for the
anchor is `released` (updated 03:31:17.483). From push to worker released:
11.5 s; from the window closing to the run fired: 4.1 s (sidecar boot and
closure install); run to release: 1.9 s (the 2 s end poll). Five workers over
the session, every one within 8 to 10 s from anchor row to cancellation.

The worker's run log landed in full before the cancellation
(`hub-data/workflow-runs/run_e54cb687…`: `RunStarted` … `StepCompleted..RunCompleted`,
`compact run …__events__0 events`, `ChildCompleted`, all at 03:31:12, then
`CancelRequested`, `CancelPropagated..RunCancelled` at 03:31:14). One pack was
refused after it, as 12.4 describes for a top-level run that ends:

```
WRN hub·lookups: Workflow-run pack rejected for 'run_e54cb6871cf48f724e6e120329b894e6-proof-…-localhost': source address has no live deployment anchor   03:31:14.562
```

It carries only the anchor's own terminal events; nothing of the body run is in
it.

Not met: the verdict. The timeline for #20 shows no entry for the worker's
head; the only entries are the listener's (`run_e0352aba…__events__1` for the
head before the proof, and (f) below). The observer reads the host's live
listener deployments (`resolveLiveDeployments`, listeners by default), so a
worker's body run is never read and its verdict never recorded. That is step 2
of section 11, worker observation, which this step does not include; the data
it needs is there, as the landed log shows. Until step 2 lands the head stays
`queued` after its worker, which also shapes (d) and (e).

(b) Reconciler pass with a worker alive, pass. Commit pushed 03:33:18.4,
`worker_spawned` 03:33:27.107 (`run_c3b1a63a…`), `POST
/repositories/TRI/widgets/enable` at 03:33:27.39 (its `onEnabled` runs a
reconciler pass), `worker_ended` 03:33:29.115. No `triage_rotation_adopted` in
the whole session's log (0 lines), the worker's anchor holds exactly one child
run, and the listener anchor `run_e0352aba…` stays `running` throughout. An
idle pass writes no log line, so the pass itself is evidenced only by the
route's 200 and the absence of effects.

(c) Second commit while the worker runs, pass for the queue, not exercised for
the wait. First head queued 03:35:15.678, `worker_spawned` 03:35:21.912
(`run_fcc6b706…`); second head `7798a82b…` queued 03:35:22.834 while that
worker was alive; `worker_ended` 03:35:23.920; the coalescer's window for the
second head closed after that, so the coordinator spawned it at once
(`run_8c21a73e…`, anchor 03:35:27.124, `worker_spawned` 03:35:29.163,
`worker_ended` 03:35:31.189). With a 2 s run and a 3 s window the queue never
had to hold a job behind a running worker; the unit test covers that branch.
Superseding the older result needs the verdict recorded (step 2).

(d) Hub restart mid-worker, pass for the release. `worker_spawned` 03:36:16.638
(`run_3365073b…`), SIGTERM 03:36:17.010, hub down 03:36:17.122, restarted
03:36:17.125:

```
{"msg":"worker_released_on_start","tenantId":"tnt_bc3681ef…","runId":"run_3365073be6e677a96d421d0d004e08e9"}   03:36:18.482
```

The orphan's body run is `failed` (03:36:20.817) and its anchor `cancelled`
(03:36:22.518). Not seen within the two minutes watched: the retriage of head
`7acb8b0b…`. The head's stored state is still `queued` from the coalescer's
hand-off (no observer writes for workers, see (a)), so the reconciler's
requeue rule waits on its attempt policy rather than on the failed run.

(e) Retry with a worker alive, pass for isolation, blocked for delivery.
`worker_spawned` 03:34:19.207 (`run_2972928f…`), `POST
/api/integrations/github-triage/:tenantId {repo, number: 20}` at 03:34:19.35
answered `409 already_queued`; no mail reached the worker (one child run) and
none the listener. The same call at 03:34:48, with no worker alive, answered
`409 already_queued` again, for the reason in (a): the head is never marked
done. The retry's path to the listener is unchanged code
(`sendBridgeMail`), but it could not be shown here.

(f) Flag off, pass. Hub restarted with `TRIAGE_COORDINATOR=off` at 03:38:16;
commit pushed 03:38:23.7, hook queued 03:38:23.775, listener child run
`run_e0352aba…__events__2` completed 03:38:27.705, verdict recorded for
`31d8404c…` at 03:38:27.516 (`ready-monitoring`); no worker row, no
coordinator log line.

Totals over the session: `worker_spawned` 6, `worker_ended` 5,
`worker_released_on_start` 1, `worker_spawn_failed` 0, `worker_wait_failed` 0,
`worker_release_failed` 0, `triage_rotation_adopted` 0.

What this changes: step 2 (worker observation) is the gate for the verdict,
the supersede and the retriage paths, and should ship before the flag is
turned on anywhere. The spawn-to-fire cost is the sidecar boot measured in
12.2; the end poll adds up to 2 s.

### 12.8 Live proof of step 2, worker observation (2026-10-14, local stack)

Same setup as 12.7, hub from this branch, `TRIAGE_COORDINATOR=on`,
`TRIAGE_RECONCILE_INTERVAL_MS=30000`. The observer now reads, after the host's
live listeners, every worker deployment live or released within
`2 * TRIAGE_RECONCILE_INTERVAL_MS + 2 * TRIAGE_RECORD_MS` (64 s here, 10 min
4 s by default), so a worker's log is read while its run goes and until the
reconciler pass that settles its head; its run is recorded and settles its
head through the unchanged recorder and plan. Two intervals because the
reconcile loop skips a kick while a pass drains, so passes can be two
intervals apart; the record interval on top because an observation is reused
for that long. "Ended since the last reconciler pass" was considered and
rejected: the observer is shared with the 2 s recording pass, which would move
that mark and hide the worker from the reconciler. (The proof below ran with
the one-interval window.)

Accepted limit: a worker that fails after its judge step posted comments is
requeued, and the retry's run posts its own; when the judged verdict differs,
the pull request carries both runs' comments. Each scenario pushes a commit to
TRI/widgets#20; the verdict is read through the triage-verdicts route.

(a) One commit, pass. Pushed 03:46:36.8, `worker_spawned` 03:46:43.376
(`run_f926bf48…`), verdict recorded at 03:46:43.929 from the worker's body run,
before `worker_ended` 03:46:45.387; the route answered it at 03:46:45.44:

```
{"verdict":{"runId":"run_f926bf48b6741f5469009912d947b0dc__events__0","headSha":"5d7a5ce4…","at":"2026-10-15T03:46:43.929Z","state":"ready-monitoring","verdict":"pass"},"run":null}
```

(e) Retry after the worker, pass. `POST /api/integrations/github-triage/:tenantId
{repo, number: 20}` at 03:47:58.9, after one reconciler pass, answered `202
{"status":"queued"}` where 12.7 saw `409 already_queued`: the head was settled
by the worker's run. The retry ran on the listener (`triage_requested`
03:47:59.118, `run_e0352aba…__events__3`, verdict 03:47:59.971); the retry
enqueues to the coordinator in step 3.

(c) Second commit while the worker runs, pass. Pushed 417917c at 03:48:23.8,
`worker_spawned` 03:48:30.142 (`run_2d7de25e…`), second push 9e1b9d1 at
03:48:30.6 queued while that worker was alive, `worker_ended` 03:48:32.150, the
second worker `run_fbc40d7d…` spawned 03:48:36.971 and ended 03:48:38.986. Both
verdicts are recorded (timeline entries 03:48:30.794 for 417917c and
03:48:37.493 for 9e1b9d1); the route's latest verdict for #20 is the second
worker's, for 9e1b9d1.

(d) Hub restart mid-worker, pass. Pushed 0c4b2e5 at 03:49:12.1,
`worker_spawned` 03:49:20.405 (`run_bb582960…`), SIGTERM 03:49:20.671, hub up
03:49:22.87:

```
{"msg":"worker_released_on_start","tenantId":"tnt_bc3681ef…","runId":"run_bb582960f8fa9c7d90942a8ba7ae8add"}   03:49:22.029
{"msg":"triage_requeued","tenantId":"tnt_bc3681ef…","repo":"TRI/widgets","pr":20,"headSha":"0c4b2e59…","reason":"run failed"}   03:49:52.129
```

The orphan's body run `run_bb582960…__events__0` is `failed` (ended
03:49:24.395) and its anchor `cancelled` (03:49:26.057). The first reconciler
pass after the restart read the released worker, failed the head on its run
and requeued it; the listener's run `run_e0352aba…__events__4` recorded the
verdict for 0c4b2e5 at 03:49:52.892, 40 s after the push, 30 s of which is the
reconciler interval. The one `ERR` line in the session is the dying child's
`event-channel send failed … EPIPE` at the SIGTERM.

Totals since the hub started from this branch: `worker_spawned` 4,
`worker_ended` 3, `worker_released_on_start` 1, `triage_requeued` 1,
`triage_runs_unobserved` 0, `triage_verdicts_unrecorded` 0,
`triage_rotation_adopted` 0.

Cost: a released worker's log is read once after its run ended and kept in the
observer's memory until the window drops the worker; a live worker's log is
listed every recording pass (2 s), settled runs not read again
(`createTriageRuns`). With the
default 5-minute interval that is one small listing per worker released in
the last five minutes; step 3 can shorten it once the reconciler is told of a
worker's end directly.


### 12.9 Live proof of step 3, every mail through the coordinator (2026-10-14, local stack)

Same setup as 12.7, hub from this branch, `TRIAGE_COORDINATOR=on`,
`TRIAGE_WORKERS_GLOBAL=1`, `TRIAGE_RECONCILE_INTERVAL_MS=30000`. The listener
anchor `run_e0352aba…` held 5 child runs before the session and 5 after it: no
scenario mailed the listener.

(a) One commit, pass. Pushed 40b3b8b 05:21:19.6, `forwarded` 05:21:23.106,
`worker_spawned` 05:21:30.371 (`run_123de65d…`), `worker_ended` 05:21:32.436.

(b) Retry through the coordinator, pass. `POST
/api/integrations/github-triage/:tenantId {repo: "TRI/widgets", number: 20}` at
05:21:53.4 answered `202 {"status":"queued"}`; `triage_requested` 05:21:53.567,
`worker_spawned` 05:22:01.771 (`run_b734526c…`), `worker_ended` 05:22:03.778.
While it ran, `GET /api/integrations/triage-queue/:tenantId` answered:

```
{"coordinator":"on","queued":[],"running":[{"repo":"bitbucket-datacenter:TRI/widgets","number":20,"headSha":"40b3b8b5…","source":"retry","workflow":"pr-triage-bitbucket-datacenter","queuedAt":"2026-10-15T05:21:53.567Z","startedAt":"2026-10-15T05:21:53.567Z","ageMs":1039}]}
```

and `{"coordinator":"on","queued":[],"running":[]}` once the worker ended.

(c) Reconciler requeue through the coordinator, pass. Pushed cfc1d2c
05:22:18.8, `worker_spawned` 05:22:30.881 (`run_b72af08e…`), SIGTERM
05:22:31.364, hub up 05:22:31.5, `worker_released_on_start` 05:22:33.949,
`triage_requeued` 05:23:04.089 (`run failed`), `worker_spawned` 05:23:10.528
(`run_c47d8108…`), `worker_ended` 05:23:14.543; the verdict for cfc1d2c is the
requeue worker's (`run_c47d8108…__events__0`, 05:23:11.692, pass,
`ready-monitoring`).

Sidecars per worker: one. The five allocations of the session (listener and
four workers) hold five distinct `sidecar_id`s. The pinned Interchange lets a
provisioner place an allocation on an existing sidecar (`ensure` returns
`sidecarId`, `sidecar-allocation/contracts.ts`), but the hub's local
provisioner (`apps/hub/src/sidecar/local-provisioner.ts`, `spawn.ts`) starts
one `apps/sidecar` process per allocation and never offers an existing one.
Packing workers is a change to that provisioner, not to the coordinator; it is
not in this step.

### 12.10 Live proof of two heads after a restart (2026-10-14, local stack)

Same setup as 12.9, `TRIAGE_WORKERS_GLOBAL=1`,
`TRIAGE_RECONCILE_INTERVAL_MS=30000`.

Reconciler pass with two claimed heads, pass. Hub stopped 05:35:58; pushed
91108a7 to PR 20 and 1ddc9df to PR 17 at 05:35:59 (webhooks lost); hub up
05:35:59. The pass at 05:39:31.836 requeued both (`run never started`);
`worker_spawned` PR 17 05:39:38.258 (`run_664288cc…`), `worker_ended`
05:39:42.276, `worker_spawned` PR 20 05:39:48.503 (`run_673c69e1…`),
`worker_ended` 05:39:52.536. Both verdicts recorded (pass, `ready-monitoring`);
the queue was empty afterwards. One worker at a time is the global limit of 1,
not a lost head.
