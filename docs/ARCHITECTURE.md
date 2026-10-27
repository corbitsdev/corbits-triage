# Architecture

Triage is an app on [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, grants, credentials, workflow runs and
audit. Triage is a hub composition, a client-driven portal, and the workflow
and tool packages the hub publishes and deploys.

## Components

```
GitHub ──webhook──► Hub ──spawn──► Sidecar ──► listener, manager
   ▲                 │  ▲                          │
   │                 │  └──── portal (/api) ───────┤
   └─── PR actions ──┴──── GitHub reads, actions ──┘
```

- **Hub** (`apps/hub`): the stock Interchange hub plus one composition
  block: `@corbits/webhooks` at `/api/hooks`, `@corbits/artifacts`,
  `@corbits/cron`. Its generic hook route answers 404 `unknown_hook`:
  `@corbits/webhooks` 0.3.1 fires a run without naming its sender, which the
  sender gate refuses. In the image it also serves the built portal, so one
  origin carries the portal, the API and the webhooks. Triage adds:
  - **GitHub bridge**: verifies GitHub's HMAC on `/api/hooks/*`, updates the
    tenant's repository list from installation events, and hands pull
    request, review, comment, `check_run` and `check_suite` events to the
    coalescer. A check event does not say whether its pull request is a
    draft or still open, so a window of check events alone reads that once
    at its flush rather than once per delivery. A pull request merged into
    the default branch marks the repository's other triaged heads `stale`; a push to the default branch
    that touches the policy file reads it again. Bitbucket Data Center has a
    provider hook of its own (`apps/hub/src/provider-hooks`). Both verify with
    `@corbits/common/x-hub-signature`, the scheme `@corbits/webhooks` 0.4 adds
    as `verify: "x-hub-signature"`; once the hub runs that release, the
    bridges move onto the stock hook routes.
  - **Policy file**: every trigger mail and portal read takes a
    repository's policy from `.corbits-triage.yml` (or `.yaml`) on its default
    branch, naming the file and its blob sha as the source. The hub keeps each
    read in memory, nothing stored; a push to the default branch that touches
    the file (GitHub `push`, Bitbucket `repo:refs_changed`) reads it again,
    and a failed read is not kept. While a repository also has a stored
    policy and the two run differently (compared rule by rule and step by
    step, never as text), or the file is refused, the stored policy applies;
    once they run the same, the hub archives the stored policy. A refused file
    with no stored policy is `invalid`, and a stored policy the hub refuses
    is `corrupt`; for either, a pull request event or the reconciler mails the listener
    `policyUnreadable` with the reason and no pack, so the manager marks the head
    failed instead of triaging it, once per head. A push that leaves the policy
    unreadable, and on Bitbucket Data Center any default branch push, triages
    every open pull request again. Routes:
    `GET …/policy/file` (the file and why it is refused),
    `POST /api/integrations/policy/validate` (open, reads only its body),
    `GET …/policy/upgrades` (`start`, `upgrade`, `differs` or `ok` per enabled
    repository, each naming its host as `source`) and `POST …/policy/export`,
    which opens or updates one pull request on `corbits-triage/policy`
    writing the stored policy, or the starter policy for `start`, as a
    schema 3 file. For a repository with no file, no stored policy and no
    policy pull request open it can instead write a chosen `text`, refused
    when triage would refuse it once merged, `extends` resolved. The file
    and export routes take the repository's host as `source`; without it,
    a name connected on both hosts is refused.
  - **Coalescer**: one pull request's burst of webhook events goes out as one
    mail to the tenant's live listener for the repository's host, as the
    tenant system sender, the same path cron uses, naming the host as
    `repoSource`. A workspace with no live listener runs nothing: the head
    fails saying Triage is not running on that host and that Settings →
    Triage shows why. When the policy depends on CI, a head whose CI is still
    running is not mailed: its triage-state row turns `waiting` and keeps the
    window's events (`triage_waiting_ci`). The window that sees CI finish, or
    its first check fail, mails the head once with those events; a head with
    no checks waits up to 2 minutes, and none waits more than 60. Manual runs,
    the backlog run and retries after the base branch moves are not held.
    When a head starts waiting and the role holds Labels (GitHub) or Comment
    (Bitbucket), the hub also mails it once with `kind: "waiting"`, which only
    mirrors the waiting marker.
  - **Reconciler**: one per host, for workspaces whose listener for the host
    is live. On an interval it compares each enabled repository's open pull
    requests with the managers' runs, their recorded verdicts and stored
    state, and
    re-queues every head without a verdict, and every stale head at most once
    per 15 minutes, under a per-tenant in-flight cap. A repository's open pull
    requests are listed again only once a webhook named it, until a minute
    after that webhook since the host's listing can trail it, or its last
    listing is 30 minutes old. Once its webhook heard nothing for 30 minutes
    (on GitHub the App's, for every repository; on Bitbucket the repository's
    own) it is listed every pass. It reads the CI of every
    `waiting` head and queues it once CI finished or its wait ran out; this
    releases Bitbucket heads, whose builds send no webhook, and any head whose
    `check_run` never arrived. Moving a head from `waiting` to `queued` is a
    compare-and-swap write, so a check run and the reconciler releasing it
    together start one run. It mails its heads to the listener. A listener
    counts as live while it runs or is on its sidecar, and as starting for six
    minutes after it is deployed, longer than a roll waits for it; the
    reconciler mails the newest running listener, else the newest starting
    one. One deployed without a sidecar past that is released, and a host
    left with no live listener has its workspace rolled again. The
    workflow-versions route reports each deployment's `live` as a manager's
    is counted, which Settings reads.
  - **App Manifest conversion**: GitHub returns a one-time code that must be
    exchanged server side, so the private key never reaches the browser. The
    `state` round-tripped through GitHub is signed by the hub and bound to the
    user who started setup, so no setup state is stored.
  - **Integration routes** under `/api/integrations/`, each described in
    `/openapi.json`: sign-in methods, GitHub App setup and installation sync,
    open pull requests, details, merge states, actions, held actions
    and single pull request triage, verdicts, stats and timeline, the policy
    schemas and routes above, invitations, workflow deploy and versions,
    Bitbucket Data Center, and code review.
    `GET …/github-triage/{tenantId}/policy?repo=&source=` answers a
    repository's policy as triage reads it on that host (GitHub without
    `source`), with the merge risks of its automatic approve or merge
    computed there, which the portal shows for GitHub repositories, and
    `POST …/github-triage/{tenantId}/backlog` starts backlog triage, so only the hub resolves policies and builds
    trigger mail. `GET …/merge-states/{tenantId}?repo=&numbers=` (at most
    100) says whether the host would merge those pull requests now: one
    GraphQL query on GitHub, each one's merge checks on Bitbucket Data
    Center. The portal asks about passes only and fails closed: a pass is
    ready to merge only on the host's explicit yes (GitHub `clean`,
    `unstable` or `has_hooks`, Bitbucket `canMerge`); anything else not
    explained is "Checking merge state". Pull request actions are synchronous: a maintainer's click
    must not wait on a workflow spin-up.
    GitHub's answers to open pull requests, details and merge states are
    shared by the workspace and kept per repository until a GitHub webhook
    about it, or the hub's own write to it, arrives; check and push events
    leave the open pull request listing kept. A lost webhook costs at most
    `KEPT_MS` in `src/github/repo-reads.ts`: longer for the listing, short
    for details and merge states, which also follow commit statuses the App
    is not sent. A mergeability GitHub has not worked out yet, or a block
    without its review decision, is never kept, and at most `MAX_KEPT` reads
    are kept. Bitbucket Data Center is read live.
  - **GitHub calls**: every hub request to GitHub passes one gate. It logs a
    `github_calls` line each minute with the calls by route and installation
    and the last rate limit GitHub reported. Once GitHub rate limits an
    installation, the gate refuses that installation's requests without
    calling GitHub until the reset; a request that names no installation is
    counted but never refused. Routes answer 503 `github_rate_limited` with
    `Retry-After`. The reconciler logs the limit once and schedules a pass for
    the reset; earlier passes make no calls to that installation. A webhook
    whose pull request or CI cannot be read for the limit is not mailed; its
    head is left for the reconciler.
  - **Request log**: the `/api/integrations/` routes, and requests the hub
    refuses before routing (an undecodable path, an unverified account), log
    method, path and status on the stock `hub.requests` category. The query
    is never logged: the manifest callback's carries GitHub's one-time code.
    A refused workflow deploy also logs `workflow_deploy_refused` with its
    code and reason.
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`s. The local-process provisioner runs child processes
  on the hub's machine, restores them on boot and declines a placement while
  free memory is short. The Docker provisioner (`packages/provisioner-docker`),
  registered after it when a daemon with the sidecar image answers, runs each
  sidecar in a container of its own. A published hub image carries the digest
  of the sidecar image CI pushed just before it, and the provisioner pulls that
  image when a placement finds it missing. The provisioner declares `isolation:workload`;
  workflows that require it land there, and probes then require it too.
  The E2B provisioner (`packages/provisioner-e2b`), registered after Docker
  when `E2B_API_KEY` is set, does the same with one E2B sandbox per sidecar.
  The Railway Sandboxes provisioner (`packages/provisioner-railway`),
  registered after E2B when its token and environment are set, does the same
  with one Railway sandbox per sidecar.
  [provisioners/](provisioners/README.md) describes each.
  Code review requires `isolation:workload`; without Docker, E2B or Railway Sandboxes, stock
  Interchange refuses it with `provisioner_no_match`.
  `GET /api/integrations/code-review/{tenantId}/place` names the provisioner
  stock's plugin registry selects for it under the workspace's placement
  policies, or null, and lists every place the hub's provisioner packages
  describe (`DOCKER_PLACE`, `DOCKER_REMOTE_PLACE`, `E2B_PLACE`, `RAILWAY_PLACE`) with the state the hub
  found at boot, for Settings → Code review. The hub's own machine is never
  one. While it is null **Review again** refuses (`no_isolated_place`),
  nothing is mailed, and the repository page links Settings → Code review.
- **Portal** (`apps/web`): owns setup. It writes the tenant, credentials and
  inference offerings over stock hub routes. Its build bundles the workflow
  sources, which the hub publishes and deploys (see the listener below). It
  is a wrapper over the routes; nothing is possible only through it. Each
  minute and on focus it reads the served `index.html`; once its hashed entry
  script differs from the one the tab loaded, it offers a reload.

## Workflows

Each is an `onTrigger` mail listener: each mail spawns a child run that
executes and ends. The bridge and the reconciler find the target by workflow
name per tenant; no deployment ids are configured anywhere. Each declares
`mailAccept: { tenant: true }`, so Interchange's sender gate admits the hub's
`github` sender (a principal in the deployment's tenant) and refuses mail from
any other tenant or an unknown sender.

- `repo-scan`: one run that reads a repository's most recently updated closed
  pull requests (200 by default) and measures what maintainers merged and
  closed. The hub does not deploy it.
- `triage-listener-github` and `triage-listener-bitbucket-datacenter`
  (`triageListener` in `@corbits/triage-manager`): a workspace's listener for
  one host. The hub mails it the pull requests it recorded that have no
  manager up (`items`); for each, it deploys a manager through the stock deploy route with its run
  token, from the manager's source asset at the commit and the offerings the
  hub publishes beside it in `release.json`, read as each body runs, and
  wakes it with a mail that names only the pull request. A pull request
  whose manager is up is mailed that manager instead, so a later webhook
  does not deploy a second one. A mail that is not
  the hub's, that names no pull request, or that finds no manager in
  `release.json` fails its body. Built with the release the module loads,
  its definition declares `workflow:*` `create` and `read` on exactly the
  manager's asset, sourced from its creator; built without one, neither.
  The hub publishes and deploys it (`apps/hub/src/workflow-release/`). A
  roll of a workspace runs in the background of what triggered it: at start,
  for every workspace holding the `pr-triage` role; once a workspace's
  credential or catalog writes through the stock routes go quiet for three
  seconds, so a key saved as several writes rolls once; when the GitHub App
  is connected or its key replaced, a Bitbucket Data Center instance is
  connected, its token replaced or its webhook secret rotated, and when
  GitHub installations sync; and when a reconcile pass finds a connected host
  with no live listener. At most two rolls run at once across the hub, and
  one per workspace across hub processes, under a Postgres session advisory
  lock held on a connection reserved for it, so a roll holds no transaction
  while it waits. A hub whose build has no `packages/sources/index.json`
  logs `workflow_release_unbundled` with the path at start and rolls nothing.
  A roll reads the workspace's catalog the way stock's model discovery does
  and leaves out a host while the workspace has no decision model. It
  publishes the portal build's sources (`packages/sources/` under
  `PORTAL_DIR`, or `apps/web/public/` when the hub serves no build) in the
  build's order as source-format `workflow` assets through the stock asset
  service, as the workspace's `triage-publisher` system principal, which it
  gives the `Deployer` role; once a roll leaves every host's listener
  running, the role is taken from every person who holds it. Each host's code review, judge, manager and
  listener publish in that order: the manager's tree gets a `release.json`
  naming the code review and judge just published and the offerings each runs
  on, the listener's the same for the manager. A chain workflow publishes
  only while the workspace has every model it names, so code review publishes
  once its key is saved, and the release after that gives the manager and the
  listener new assets. An asset is named `<workflow>-<publisher>-<8 hex>`,
  the build's content hash or, for a workflow with a release, a hash of it and
  its `release.json`. An asset another principal created is refused, and one
  already published keeps its commit only while that commit's tree is the
  release's files; any other tree fails the roll. The publisher gets `read`
  on the asset of each workflow another one deploys, since stock gives a
  creator none and a listener deploys its manager under its creator's read.
  The roll raises the tenant's `lifecycle.maxLifetime` to the longest
  Interchange accepts when it is unset or lower, since stock takes no
  lifetime per deployment and the definition does not exist before the first
  one, so a listener lives until a newer one replaces it. A host whose newest
  live listener runs the published listener's commit keeps it without
  waiting on it, and the host's older listeners stop; otherwise, and when a write changed that
  host's credentials, the hub deploys the listener through the stock
  workflow allocation service with the publisher as its source authority,
  waits for it to be live (cancelling it after five minutes), then cancels
  the host's other live listeners and every live deployment of the
  workflows the listener replaced: pr-triage, pr-triage-historical, the
  standalone code review and the PR workflow variants. A model key or
  catalog write deploys every host's listener again, a host's own
  credential only that host's. Until the new listener runs, the hub mails
  pull requests to the one it replaces, and a listener counts as starting,
  not stuck, for longer than a roll waits for it. A failed roll leaves the
  previous listener running and is tried again about ten minutes later, as
  is a roll that finds another hub process holding the workspace; the hub
  logs `workflow_release_failed` with the cause, and the workflow-versions
  route reports the host, when the roll ended and, when it failed, a fixed
  sentence under `rollouts`, which Settings → Triage shows beside each
  host's running version. A published workflow's asset,
  and so its definition, is named for its publisher and release, so the hub
  finds a deployment by the workflow id in its frozen projection
  (`apps/hub/src/github/deployment.ts`), and the workflow-versions route
  reports a source deployment's asset, commit and package from its closure.
  A host's listener and its managers are released once the host is
  disconnected: right away when Bitbucket Data Center is disconnected through
  its route, and on the next reconcile pass when the GitHub App credential is
  removed. A running listener keeps the credentials it launched with, which is
  why a credential write deploys its host's listener again; managers and
  judges launch with the current value.
- `triage-manager-github` and `triage-manager-bitbucket-datacenter`
  (`triageManager`): one live run per pull request, which runs only while it
  has work, and the only workflow that writes to the pull request. It takes
  mail from the hub (`tenant`) and the listener that deployed it (`invoker`).
  A mail starts a loop of passes. Each pass
  takes, which claims the pull request and its pending events and answers the
  newest pull request mail the hub recorded. Each held Do approved since runs
  as pr-triage runs an approval, which skips one whose pull request moved past
  its head. Then, when the pass has a mail for its head, a judge or code
  review report, or an overdue reviewer, pr-triage's own steps run on the
  newest mail for the head, handed over as `{ taken }`, which they trust as
  the hub's: a head held for CI is marked waiting when that mail is the newest
  for it. Anything else is triaged. Every pass runs its approvals step, which
  approves nothing when there is nothing to run. A policy of only deterministic
  rules posts on this pass. One whose rules need the judge, or that asks for
  code review, posts once, after each of those has reported or given up: the machine
  verdict, the judge's verdict and the code review together. Done reports what
  the pass ran: the approved Dos' outcomes, a head it held for CI, or the
  verdict it posted as its evaluate, mirror, execute and rules steps output
  it, with the facts the verdict keeps rather than the diff. Each branch that
  reports one of these has its own done step. A pass that posted to the host
  or mailed a judge or code review asks done to `wait`. Done then answers
  `more` when an event is pending, and the next pass runs at once; `more` with
  `wait` after a pass that asked, and the next pass runs once 30 seconds have
  passed, taking whatever arrived meanwhile; otherwise `ended`. So a manager
  ends 30 seconds after it last posted or mailed, never waiting out a judge or
  a code review: their results reach the hub, which wakes the pull request's
  manager the way a host event does, and the listener deploys a fresh one once
  the claim has ended.
  Once the passes end, fail or run out, or take finds another run holds the
  claim, the run's last step stops it through the stop-run route under a
  `manage` grant on its own run, so the run is ended once and never keeps
  the claim: the next manager's take finds the run gone and claims.
  A run left deployed with no sidecar for two minutes is gone too, and its
  cancellation is requested so it does not start after the claim has moved on.
  When the rules need the judge, the host's own checks have finished (or the
  hub waits for them no longer) and `release.json` publishes a judge for the
  host, a pass deploys it under `workflow:*` `create` and `read` on exactly
  the judge's asset, which the definition declares when its module loads with
  that release, mails it the rules output until the judge's one-hour deadline,
  and posts nothing. While those checks run, the judge is held and the pass
  marks the head waiting, as a pass of deterministic rules does. The pass that
  collects the judge's report posts and executes its verdict as the judge made
  it, once that verdict names the pass's pull request, head and host; facts
  and rules still run, and when they no longer need the judge (a failed hard
  rule, a draft or a closed pull request) the pass's own verdict goes up
  instead. A decided verdict, one that does not wait and that nothing on the
  host can still change, stays on the judge's reviewer on the claim for its
  head, so a later pass on that head posts it again, whatever else changed,
  and deploys no other judge; a new head gets its own. A verdict the host's
  checks could still change, a degraded one or one over 256 KiB still goes up
  on the pass that collects it, and a failure or a missed deadline leaves the
  machine verdict to go up alone; none of them is kept, so the next event
  deploys the judge again. A judge the release does not publish posts nothing.
  When the policy turns code review on, the verdict's rules let it past, the
  hub read the head's review request and the release publishes a code review,
  a pass deploys it the same way (without one it declares no code-review
  asset, and the verdict goes up alone), mails it the request until the
  review's one-hour deadline, and still posts nothing while that review is
  out. A pull request whose failed rules shut the rules gate, or that the
  block's `for`, `when.triage` or `when.paths` leaves out, read from the rules
  step's facts and the verdict, is not reviewed; done reports why on the
  verdict as `codeReviewSkipped`, which the portal shows as Not reviewed. One
  triage could not read is not left out: its review waits while `for` or
  `when` could leave it out. The pass that collects its report mirrors the
  verdict, then posts the review through the host's `send_code_review` tool,
  so they go up together. A review stays on its reviewer for its head like a
  decided verdict, so a later pass on that head whose rules still let code
  review past posts it with the verdict and deploys no other; a review that
  could not be mailed, reported a failure or ran past its deadline leaves the
  verdict to go up alone and is deployed again on the next event. Each
  reviewer keeps its head and deadline on the claim, so whichever manager
  takes the next pass on that head sees a deadline that passed with no
  report; it posts the verdict without that reviewer, which for a judge is
  Needs Human Review and for code review holds approve and merge for a person,
  and done logs `reviewer_overdue`. The triage reconcile pass, every 5
  minutes, wakes a manager through `createManagerWake` for each pull request
  whose manager is not up while a reviewer of its newest head is past its
  deadline with no result recorded (`createOverdueWake`,
  `apps/hub/src/manager-intake.ts`), and logs `manager_woken_overdue`. A
  wake that succeeded is recorded on the claim (`overdueWokenAt`), and the
  next pass wakes again only once the manager start grace has passed: two
  minutes when a manager has taken the claim since, thirty while none has, so
  a manager slow to reach a sidecar is never deployed twice. Each pull request
  is woken on its own: one whose wake fails is logged as
  `manager_overdue_wake_failed`, the rest are still woken, and the next pass
  tries it again. The same pass wakes a pull request whose manager is not up
  while a reviewer result no pass has taken waits for it, as after the
  reviewer-result route could not wake one, once two minutes have passed
  since that result was recorded, so a manager the route's own wake deployed
  is not deployed again while it starts, and with the same hold after its
  own overdue wake. So
  within one pass of the deadline that manager posts the verdict without the
  reviewer and the pull request needs a person. Each reviewer the manager
  records names the manager run that deployed it (`deployedBy`). Done stops a
  judge or code review this run deployed that ran past its deadline on the
  pass's head, through the same stop-run route. Stock grants the
  deployer `read` on a run it deployed, and the vendored Interchange carries
  `manage` instead (`vendor/interchange/VENDORED.md`). A reviewer on an older
  head is stopped by the hub, which a later manager could not do: see intake
  below.
  The hub records the verdict done reports as the manager run's, in done's
  transaction (`apps/hub/src/manager-routes.ts`), with the row-building code
  pr-triage's run logs use (`apps/hub/src/github/verdict-row.ts`). The
  reconciler and Triage again read the managers of the pull requests they look
  at from their claims and those rows (`apps/hub/src/github/manager-runs.ts`):
  a manager that is up runs the head of the newest pull request mail recorded
  for it, so its head is not mailed again; one that went away with a pass open
  failed on that pass's head, which is retried with backoff; a head whose last
  pass was held for CI waits for its CI; a recorded verdict settles its head as
  a pr-triage run's does. Triage again can queue a head again as soon as its
  manager has reported done, or went away, since it was queued.
  Approving a held Do of a manager's verdict reads the Do from the recorded
  verdict and sends it with the mirror request its pass kept; a Do the run's
  newer verdict no longer holds answers `verdict_superseded`.
- `pr-code-review-reviewer-github` and
  `pr-code-review-reviewer-bitbucket-datacenter` (`codeReviewReviewer` in
  `@corbits/pr-code-review`): the code review a manager deploys, alone on its
  sidecar. It takes mail only from that manager and reviews the request.
  Stock runs a step whose dependencies failed, so however the review ended it
  records its `StageResult` through the reviewer-result route (a failure as
  `failed`), which wakes the pull request's manager, and stops. It posts nothing to the
  pull request. Its definition declares only `create` on
  `triage-manager:result` and `manage` on `workflow-run:self`, sourced from
  its creator: it can report a result and stop itself, and reach no other
  manager route.
- `triage-judge-github` and `triage-judge-bitbucket-datacenter` (`triageJudge`
  in `@corbits/triage-judge`): the judge a manager deploys. It takes mail only
  from that manager. It runs the model checks the machine rules produced, then
  focused's follow-up questions, then evaluate. Stock runs a step whose
  dependencies failed, so however the judge ended it records a `StageResult`
  of kind `judge` through the reviewer-result route: the whole verdict
  evaluate made, its comment, labels, Dos and rule results, or a failure as
  `failed`, which wakes the pull request's manager, and stops. It posts nothing to the
  pull request. Its definition declares only `create` on
  `triage-manager:result` and `manage` on `workflow-run:self`, sourced from
  its creator.
- A run sends mail only through an agent step's transport, so the listener
  and the manager mail through one agent whose
  director makes no model call: it runs its one tool, which waits for a
  just-deployed run to reach a sidecar until a deadline and then mails it as
  the sending run.

## Triage pipeline

The manager's pass runs facts, rules, and, when the rules need no judge, the
verdict. When they do, the judge it deploys runs the model checks and
evaluate, which decides the verdict; the manager posts that verdict. The
repository's policy decides what each step does. The steps below are those
shared ones. Before facts, a pull request mail from the hub naming a GitHub head
mirrors `unready:<owner>--<name>:<number>:<head sha>`, which takes the pass
label off that head, so it never stands on a head not yet triaged.

1. **facts**: reads the pull request, its files, reviews, CI, commits (the
   first 100 messages in full), the repository's docs and its contribution
   rules from the host. On GitHub the body is read from GitHub's own rendering
   (`body_html`, from the full media type) as plain text (`renderedText` in
   `@corbits/triage-contracts`): comments and anything else GitHub's markdown
   hides never reach it, nor attributes, diagram sources GitHub ships hidden,
   screen-reader-only text or ruby fallbacks. A link reads as its text, and
   only a link the linked-issue rule counts (a GitHub or Linear issue) keeps
   its target beside it, up to the issue's id, so the rule still finds it.
   Math is read as its source. Bitbucket Data Center shows the body as
   written. The title, body, commit messages and changed paths then lose
   controls and default-ignorable characters such as zero-width, bidi, tag and
   stray variation-selector characters (`visibleText`), so every rule, the
   judge and the comment read them as the host shows them. Patches are not
   changed. The same cleaning reports what it removed, and the facts keep
   only what that was and where (`hidden`), for the hidden-content rule. With
   that rule on, a GitHub repository's pull request templates are read from
   its default branch too, or its owner's `.github` repository's when it has
   none (`github_read_pr_templates`), so hidden markup that matches a template's
   own whole comment is not counted as the author's. The portal's pull request
   details (`/api/integrations/github-pull`) find referenced GitHub issues in
   the same cleaned title, body and commit messages; a pasted URL of an issue
   in the same repository counts too, as GitHub renders it `#<number>`.
   With the regression-risk or risk rule on, it also lists each changed file's
   default-branch commits from the last 30 days (`github_list_path_commits`,
   `bitbucket_datacenter_list_path_commits`, one page each, ten files at a
   time; tests, docs and lockfiles skipped; at most 300 files per pull
   request, GitHub's own diff limit) and keeps how many have a subject typed
   fix, bugfix, hotfix or revert (`fixes`); a history that fails, runs past
   one page or is past the 300 is kept as unread, which leaves only those rules
   unconfirmed.
   With the focused rule on, it also reads the stack (`get_stack`): the pull
   requests merged into the branch, and the open pull request whose branch it
   is based on. The host lists a pull request's files against its base
   branch, so one based on another open pull request's branch shows only its
   own changes and focused runs on them, the comment noting what it is
   stacked on. A branch other pull requests were merged into holds their
   changes too, so focused is skipped and the comment says why.
   With a duplicate rule on, it compares the open pull requests opened before
   this one on its base branch, drafts left out (`list_open_prs` with `base`,
   one call per base branch); past 100 of them it reads none and both rules
   are unconfirmed. It reads the first page of each one's changed paths
   (`list_pr_files` without patches, ten at a time), so its cost is one call
   per earlier open pull request. One with the same head commit repeats this
   one with no further read. For no-duplicate it reads the diff hash
   (`pr_diff_hash`, the hash the hub's code review takeover uses,
   `@corbits/common/diff-hash`) and commits only of those whose first page
   lists no path this one does not change, and of this one when any does: two
   calls each, usually none. An earlier one whose first page can't be read
   leaves no-duplicate unconfirmed, naming it. For duplicates-open-pull-request it keeps only
   the shortlist the judge is asked about (`overlapping`,
   `logic/duplicates.ts`): up to five that share a path on that first page,
   lockfiles left out, or two title words, most shared paths first
   (`openPulls`).
2. **rules**: runs the hard rules (built-in rules over host data, text
   rules and code-pattern rules) and, unless one failed or the pull request is a draft or closed,
   builds the judged rules' questions, or the verdict question when there are
   none.
   A code-pattern rule runs its presets' ast-grep rules and its own (its own
   win on a shared id) with `@ast-grep/napi` over each changed TypeScript or
   JavaScript file's head content its `files` and `ignores` globs admit
   (ast-grep's glob rules, checked when the policy is read), and keeps
   matches on lines the patch adds.
   A file whose patch or content was not read, or a rule ast-grep refuses,
   leaves the rule unconfirmed; `vendor/`, `dist/`, `build/` and
   `generated/` at the repository root and `node_modules/` anywhere are
   skipped and listed as skipped in the evidence, and a `?? 0` inside
   arithmetic is a counter's real default. With such a rule on, the facts
   step reads each file whose patch adds lines at the head through the host's
   `read_file` (`whole`), ten at a time and at most 300 per pull request (more
   leaves the rule unconfirmed without reading any), runs the rules there and
   outputs only the matches. Bitbucket Data Center lists no patch, so there
   the rule is unconfirmed whenever an in-scope TypeScript or JavaScript file
   is added, edited, moved or copied. The extension leaves code-pattern rules out and swaps the native module
   for a stub.
3. **route**: skips the judge when no question needs asking.
4. **judge**: one System One call per request of questions. Each first-round request and the verdict request also asks
   whether the pull request's text, diff or docs try to direct the judge; a
   confident yes in any of them leaves every judged rule unconfirmed and the
   verdict Unsure, whatever the verdict question answers. The only step that infers; see
   [DECISION_MODEL.md](DECISION_MODEL.md).
5. **parts**: a second judge map asks one question per file of each slice that
   failed focused, and the verdict question over every rule's result.
6. **evaluate**: decides the verdict, renders the one comment, and resolves
   the verdict's steps when the policy's When is woken, skipping each step
   whose conditions do not hold. While CI is pending every runnable action is
   held and an approve that may not stand is skipped; the head settles, so
   the reconciler does not retry it, and the completed `check_run` (or the
   reconciler's CI re-read) triages it again. A verdict other than Fail whose
   only unconfirmed rules are the host's (CI green pending, mergeability not
   computed) is `waiting` instead: no comment, no actions, the waiting marker
   as its mirror (`mark`). The hub records no verdict for it, nor for one on a
   closed pull request (`closed`); a waiting run with CI pending turns the
   head's row `waiting` within the 60-minute CI wait, which the coalescer or
   reconciler releases like a head it held itself. A mail with `noWait`
   (past the CI wait, a head's last attempt, or Triage again) is decided
   instead of waiting. A CI re-read that queues a head again keeps its
   attempts, since the head did not fail, and sets `noWait` by the same rule.
7. **mirror**: writes the verdict label when the `pr-triage` role holds
   Labels, and the marker comment when it holds Comment; on Bitbucket, Comment
   also writes the verdict as the `Corbits Triage` build status. It runs
   before execute, so a merge or close finds the final verdict on the head. A
   waiting verdict writes only its waiting marker. A
   waiting mail skips every other step: `markWaiting` writes only the waiting
   label or `INPROGRESS` build status under the effect id
   `waiting:<owner>--<name>:<number>:<head sha>`, and nothing once the pull
   request moved past that head. On GitHub the marker passes the fail and
   unsure verdict labels as `keep`, so a pull request carrying one keeps its
   labels until the verdict, which swaps them only when it differs. A head
   with no checks (the coalescer's `noCi` on the waiting mail, or facts'
   `checks: "none"` in a run) gets no waiting label: the marker only takes the
   pass label off. The portal reads the wait from the head's triage-state
   row, not the label.
8. **execute**: runs the actions whose kind the `pr-triage` role holds on the
   repository. Every other action is held in the verdict (`held: true`).

The hub reads which kinds the `pr-triage` system role is granted (`invoke` on
`triage-do:<kind>:<owner>/<name>`) and mails them with each trigger; the run
trusts them only from the hub's sender. The kinds are acted on later than they
are read, so a condition checked at read time would not hold at action time:
a conditioned allow does not count and a conditioned deny always applies. Close on Unsure, and merge on anything but Pass, are
always held. The hub mails the policy twice: `pack` as resolved
from the repository policy and any policy file it extends, and `checkPack`
in the shape a deployment built before steps reads.

A person holding the same grant approves a held action, or one the run failed
to write, from the Inbox: the hub mails the deployment the action, its effect
id, head and approver. That mail skips triage: an `approval` action step
reads it, trusting only the hub's sender, and execute writes the action unless
the host already shows it; a close, merge, comment or review is refused once
the head has moved. The hub reads the approval run's outcome back onto the
verdict that held it.

Every step but the judge is a deterministic `action`. Facts, mirror and
execute reach the pull request's host through its credential, bound to each
of those action handlers (`credentialBindings` with `action: <handler>`):
each declares the host's handle in `credentials` and a capability in
`effect.requires` (`pull-request.read` for facts, `pull-request.write` for
mirror and execute), and calls the host only inside `ctx.perform`'s `run`.
Facts is one effect; each mirror write and each Do is its own effect under
its call id, the Do's effect id, so a resumed run does not write it again.
The calls are the host tool's (`githubCalls`, `bitbucketCalls`), so a host
operation has one implementation.

## Code review pipeline

A repository's policy file turns code review on with its `code-review` block,
and **Review again** asks for one whatever the file says; both need a code
review provider's key. A
workspace runs one provider, the one whose key it stores in Settings → Code
review
(`CODE_REVIEW_PROVIDERS` in `triage-contracts`; only Anthropic today). A
pull request's code review runs in its manager: the hub attaches the review
request to a pull request mail whose `codeReview` is on, which the policy
file's `code-review` block or Review again sets, with the host's unified diff
cut at a line boundary past 100,000 characters; on GitHub a diff too large for the diff API
is built from the files' patches. The files a cut leaves unread, read from the
diff's headers, ride as `cut.unread` and never reach a prompt; the review sent
to GitHub lists them. The title and description are read as the facts step
reads them (`shownBody` and `visibleText` in `@corbits/triage-contracts`), so
hidden text never reaches the review. `…/run` (Review again) records a pull
request mail for the current head with code review on for everyone, on any
verdict and whatever the rules say, and names it with an `again` id. The
manager deploys one more review of a head for each `again` it has not
reviewed, even where an earlier review of the head settled.
Code review only reads: a checkout action downloads the head through the host
credential to `<SIDECAR_DATA_DIR>/checkouts/<host>/<owner>/<repo>/<sha>`, and
its tools are the host read bundle and repository reads confined to that
folder. The consolidate step reads each finding's lines at the head and reports
the findings it could show the model no line of; a comment whose group had no
member read carries `unverified`, which the portal and the review sent to
GitHub show as "Not checked against the file".

Beside the model steps, one step runs a tool and keeps what it says, as structured
findings (source, rule, path, line, message, severity, fix when the tool gives
one) and are not posted. `lint` runs the
native oxlint binary every image that runs sidecars pins (never through bun or node) over the changed files with the repository's own
`.oxlintrc.json`, nested configs off, and keeps hits on added lines. Only data
keys pass (rules, categories, built-in plugins, env, globals, settings,
ignorePatterns, overrides of the same); a config with any other key (`extends`,
`jsPlugins`, `options` among them) or one that is code (`oxlint.config.*`) is
refused unrun. The kept keys are written to a config in a fresh folder outside
the checkout, oxlint runs from that folder with only an absolute PATH, ignore
patterns are applied before it runs, and the absolute file paths follow `--`. A changed path missing from the checkout makes the step
incomplete. A repository with no config is not linted. A lint that fails is
`incomplete`, never an empty list.

Each request carries `diffHash`, a SHA-256 of the full diff, `index` lines
included, so a base change to a file the diff touches, or a binary change,
changes it. A diff with no `index` line, as GitHub's rebuilt from the file
list, is sent unhashed. A manager's code review reports the hash with its
review. `GET …/code-review` with `head` answers `carriedTo` when that head's
diff hashes the same as the newest finished review's, reading that head's diff
once; a failed read is not retried for five minutes.
The review is then sent to GitHub at that head, unless it was sent on its own,
whose comments stay on the same lines. A diff that can't be read and `…/run`
review the head instead.

Bitbucket Data Center anchors a comment to one line, so its send
(`POST …/bitbucket-datacenter/{tenantId}/code-review`) posts one comment per
finding the effective diff shows, on its first shown line, then a summary
comment with the rest. Each comment's first line is a link-reference marker
naming the head (and the finding's index), so a send that failed part-way posts
only what is missing, and none once the summary stands on either head.

A pull request's latest review (`GET …/code-review`, `code-review-runs.ts`)
is read from `manager_state`: the newest of the code reviews its claim still
waits on, shown as running from the reviewer's own record until it reports or
its deadline passes, whether or not a manager is up, those the manager gave up on, such as one past its
deadline, and the results its code reviews reported through the
reviewer-result route that a pass took or that name a reviewer of the claim. A
review that did not finish shows as failed; its run log keeps the error.

Sending a review to GitHub is a person's write through
`POST /api/integrations/github-actions/{tenantId}` (`action: "code-review"`,
the Comment grant): the hub reads the newest finished review the same way
and posts it as one `COMMENT` review pinned to its head. The review's marker
and `commit_id` are its effect id, so the App's marked review of that head is
found before anything is written.

The steps, the provider profile and how to add a provider are in
[packages/pr-code-review/README.md](../packages/pr-code-review/README.md); the
eval and its numbers in
[packages/pr-code-review-anthropic/evals/README.md](../packages/pr-code-review-anthropic/evals/README.md).

## Policy blocks

A policy file that turns a block on keeps its v4 keys in the stored policy,
and its pull request mails carry `codeReview`, `blocks` and `decide`. The
manager runs code review behind `rulesGate` in `triage-contracts`: under
`rules: pass`, the hub's default unless the block's `when.rules` is `any`, the
review stays shut unless every policy rule in the verdict's `checks` read
without a model whose failure fails the pull request passed (`hardFailures`,
shared with triage), CI only through `ci-green` and never the built-in
`not-a-draft` or `no-changes-requested`. The manager does not run `decide`,
so the hub takes approve and merge out of such a mail's `automatic` and they
wait in Needs you.

## Tenancy and authority

A signed-in user whose address is not verified reaches no hub route until it
is: the hub's front door (`apps/hub/src/verified-gate.ts`) answers every
`/api/` request from such a session with 403 `email_unverified`, before the
custom and stock routes. Open to it: better-auth under `/api/auth/` (session,
sign-out, `send-verification-email`, `verify-email`, magic links) and
`/api/integrations/auth-methods`. Webhooks under `/api/hooks/` are routed
before the gate; sidecar sockets and git and agent-state tokens carry no user
session, so it lets them through. The hub's first account (the oldest user)
is exempt unless `AUTH_ALLOWED_EMAILS` is set, so a hub without email can be
set up. Without email, that first account vouches for the rest: the invite
route lets an admin invite an unverified email and password account, and
`/api/integrations/invitations/{tenantId}/{principalId}/verify` sets
`emailVerified` for a member or invitee of the caller's workspace, under the
invite grant, logged as `email_marked_verified` with both principals. It
refuses anyone but the first account (`apps/hub/src/hub-owner.ts`): verified
holds hub-wide, and any verified account can create a workspace and bring any
account into it through stock invites, so a workspace admin's vouch would be
too weak. A hub that sends email refuses it and leaves the proof to the
emailed link. Resending that link is limited to once a minute per signed-in
account, or per address without a session, rather than by better-auth's
per-IP limit alone, since a caller can change its address. Stock has no unverified state of its own: tenant creation gives any
signed-in user an active owner membership, and the stock tenant middleware
refuses only inactive memberships, so it covers neither `/api/me` nor tenant
creation.

better-auth's sign-in and email rate limits key on the caller's address. At
start-up `clientIpHeaders` in `apps/hub/src/env.ts` detects the host from a
variable the platform sets and reads the address from the header that
platform's proxy sets: `X-Real-IP` on Railway, detected by
`RAILWAY_ENVIRONMENT_ID`. On a detected host each session also records that
address. Anywhere else better-auth reads `X-Forwarded-For` and trusts it only
when it holds one address; otherwise every caller shares one bucket per path,
so the hub logs `auth_client_ip_unresolved` once at start-up.

A workspace is an Interchange tenant; repositories are tenant config
(`corbitsTriage.repos`) plus a per-repository policy and triage state, both
tenant artifacts. Runs act under the grants materialized for their deployment.

A model step gets only read tools confined to the checkout or the pull
request's head (repo-read-tool's `read_file`, `grep` and `list`, and the
host's `*_read_file`), never a shell, network, write or push tool, and
`tooling/model-step-tools.test.ts` fails `bun run test` otherwise.

GitHub access is the tenant credential `github` (provider `github`, stock
`http`), bound to the GitHub tools and host actions. It holds an installation
token, never the App key. The vault holds the App as
`{"appId","privateKey"}` under `github-app`, which no workflow binds, and its
webhook secret under `github-hook`. The manifest callback and
`PUT /api/integrations/github-app/:tenantId` write the key and the token minted
from it in one transaction; App JSON a stock credential write leaves in
`github` is moved to `github-app` when the hub next reads the key: the next portal read, installation sync or token loop pass, so at most 45 minutes later; until then that credential holds App JSON and a deployment launched from it is handed the key. The hub
mints the token on boot and renews it every 45 minutes. Every write holds the
tenant's advisory lock, and a renewal stores its token only while the key it
minted from is still the workspace's, so a replaced App is never overwritten
with the old one's token. Each renewal then calls stock
`pushCredentialReconcile` for every running deployment holding the credential,
since a secret update alone reaches a deployment only when its sidecar
reconnects. One token covers one installation: the workspace uses the one its
repositories came from, else the oldest; installation sync and the
installation webhook leave out other accounts' repositories. A `github-app`
key whose `github` credential was deleted is dropped by the renewal loop. A
failed renewal keeps its reason as `tokenError` on the credential's metadata,
shown on the portal's GitHub App row; once the token is past its expiry the
credential is marked `expired`, which stock launch resolution skips, so no
deployment launches with it. The next good renewal sets it `active` again; running
deployments still re-resolve an expired credential, as stock drops only
revoked ones.
Hub routes that reach GitHub for the portal sign with the App key on the hub.
Each GitHub mail names the App's bot account (`<slug>[bot]`, the slug GitHub
answers for `GET /app`, refreshed on every renewal) as `appLogin`, and only
that account's comments and reviews are triage's own. Reads without a login (the
policy check Action, the extension and the local CLI check) take a marked review
from any App account as triage's own, so another App on the repository could mark
its review that way. Routes that read the host check the caller's `read`
(or `use`) grant on `github` and never return a secret; routes that write
check `use`. A pull request action of a kind triage can run also checks
`invoke` on `triage-do:<kind>:<owner>/<name>` (the repository name in
lowercase); the admin role holds `triage-do:*` from GitHub setup, and owners
hold every grant. A member given the `pr-triage` role is refused every action
until it is removed, so what triage does unattended never becomes what a person
may do. Approving a held action checks only its kind's grant.

A deployment acts with the grants its source asset's creator holds, so the
hub's publisher needs every grant the listener's chain declares from its
creator. The hub keeps a system `Deployer` role per workspace
(`apps/hub/src/deployer-role.ts`), ensured only by the publisher before each
roll, which gives it to the workspace's `triage-publisher` system principal.
It holds exactly `DEPLOYER_GRANTS` (`@corbits/triage-contracts`), and any
other grant on it is dropped: `create` on `workflow:*`, `manage` and `read`
on `workflow-run:*`, `write` on `triage-manager:state` and `create` on
`triage-manager:result`. Stock gives an asset's creator no grant on it, so
the publisher also holds `read`, granted as its creator, on the asset of
each workflow another one deploys: the manager, the judge and the code
review, not the listener.

Where triage mirrors and its policy approves, a settled head that may not be
approved dismisses the approvals the approve action made; one dismissed on a
head is not made again on it. A person's own approval from the Inbox is never
dismissed; an approve action a person lets through from the Inbox is.

The portal saves repository settings through the stock tenant update (`PATCH
/api/tenants/:id`), which the hub checks first. Besides tenant `manage`, it
takes only a repository's `enabled` and `checkPack`, and dropping a
repository. Switching a GitHub repository on needs `use` on the App
credential; switching a Bitbucket one, or dropping it while on, is refused
(409 `use_bitbucket_route`), since its own route also manages the webhook;
changing the pinned policy needs `write` on the policy pinned before and
after. Every other key keeps its stored value. The hub writes `corbitsTriage`
itself under the tenant row's lock, refusing 409 if it changed since the hub
read it, and passes the rest of the request to stock.

## Data

- Interchange's own tables, artifacts and run logs hold tenants, credentials,
  deployments and runs.
- Artifacts: the stored policy and the triage state
  (`triage-state/{owner}/{repo}`) per repository. The stored policy is the
  artifact the repository's record on its host pins by id (`checkPack.id`).
  A GitHub repository's is titled `check-pack/{owner}/{repo}` and a Bitbucket
  Data Center repository's `check-pack/bitbucket-datacenter/{owner}/{repo}`;
  a Bitbucket Data Center policy titled the GitHub way is read by its pin
  and retitled on its next save. The trigger mail names its title for
  the repository's host (`policy.checkPack.name`). A GitHub repository
  without a usable pin falls back to the newest titled
  `check-pack/{owner}/{repo}` that a record of the same name on another host
  does not pin; a Bitbucket Data Center repository has none. The triage
  state holds each open head's status (`new`, `queued`, `waiting`, `running`,
  `triaged`, `failed`, `stale`) and attempts. Each new artifact is writable
  and archivable by its creator and the admin role.
- A policy file whose `extends` is a repository name is resolved over that
  repository's policy file (`resolvePolicy`), read through the same
  per-repository cache, at the time the policy is read: built-in rules merge
  field by field, custom rules by id (at most eight together), and `when`, each
  verdict's steps and each verdict's label come from the extending file only
  when it sets them. A stored policy can't extend. Each trigger mail names the
  versions its pack was resolved from under `policy.source`;
  `policy.source.sharedFile` names the extended file and its blob. A push or
  merge to the shared repository refreshes its cache entry, so no dependent is
  tracked. A Bitbucket repository that is not enabled has no triage webhook, so
  its file is kept for a minute instead.
- Every migration runs in `bun run db:migrate` (`apps/hub/src/migrate.ts`) as
  its own step before the hub starts: `bun run dev`, Compose's `migrate`
  service, or whatever the operator runs as a pre-deploy step. It applies
  Interchange's tables with stock `drizzle-kit migrate`, then the
  `@corbits/webhooks`, `@corbits/artifacts` and `@corbits/cron` tables,
  triage's tables and the data backfills, and records the last
  `apps/hub/migrations` file it applied as the `corbits_triage` schema's
  comment. The hub refuses to start, naming what is missing, while fewer
  Interchange migrations are applied than the vendored journal lists or the
  recorded file is older than its own last one; the `@corbits/*` packages'
  migrations keep no record of their own.
- Triage's tables, in the `corbits_triage` schema: `verdict` (verdicts per
  head, with the outcomes of the actions their run executed, copied from a
  pr-triage run's log or reported by a manager's done; a manager run's newest
  verdict on a pull request replaces the one it recorded before, keeping the
  outcomes of Dos already written on its head. The verdict's `startedAt` is
  when the run first took its head, and its trigger the newest mail for it. A verdict's
  host is its run's workflow's, by the workflow id its deployment's frozen
  projection keeps, and GitHub when that run is gone), `device_code`
  (better-auth's device authorization, for agents a signed-in person
  approves) and `manager_state` (below), migrated from `apps/hub/migrations`
  by `db:migrate` in one transaction under an advisory lock. Nothing else is
  stored: GitHub App setup state is a signed token, and an invite is a stock
  invited principal.
- `manager_state` (`apps/hub/src/manager-state.ts`) holds a pull request's
  manager claim (`mgr:<source>:<repo>#<n>`: status, the run it names, the
  open pass, reviewers and closed passes, each closed pass with whether it
  held its head for CI, and the newest pass of a run on a head with the mirror
  request of the verdict it posted) and its pending events
  (`evt:<source>:<repo>#<n>:<deliveryId>`), each change one short
  transaction. Recording an event is a no-op on a redelivery; the database
  stamps `receivedAt` to the microsecond as it inserts the row, so events
  sort in the order they were recorded. A held Do's approval names the
  pass's head only when no mail or earlier pass does, so approvals alone on a
  fresh claim are a pass; a reviewer result alone before any pass has no head
  and stays pending, and done waits only on events take can use. Take claims
  the pull request for the calling run when no live run holds it: the
  claim is missing or ended, or the run it names has gone, whose open pass
  the caller resumes. Concurrent takes queue on the claim's row lock, so one
  claims it and every other is refused and stops itself. Take and done
  refuse any run the claim does not name. Take resumes
  the open pass or takes every pending event no other transaction holds,
  keeps the newest head and consumes reviewer results for other heads;
  reviewer results that arrive before the first pass stay pending. Either
  way it answers the reviewers the last done recorded and the newest
  pull request mail recorded: the pass's own, or for a pass without one the
  newest `pr` mail. Done
  closes the pass and, under the claim's lock, ends the claim when no event
  is pending and the pass did not ask to `wait`, so an event committed before
  it is taken by this manager and one after it by the next. A manager run reaches take and done, and a reviewer run records its
  result (under its own run id), through `POST
  /api/tenants/:tenantId/manager/{take,done,reviewer-result}`
  (`apps/hub/src/manager-routes.ts`). They admit a run token only, as the
  hub's extra run-token routes. Take and done need `write` on
  `triage-manager:state`; reviewer-result needs `create` on
  `triage-manager:result` and nothing more. The calling run is the token's
  run, never a body field. Take and done
  answer 409 `not_manager` to a run the claim does not name. Done's body
  carries the pass's `report` and `approvals`: the hub keeps the report on the
  closed pass (a pass that reported without taking events, as one past a
  reviewer's deadline, is closed as its own), and in the same transaction
  records a posted verdict and sets each approved Do's outcome on the verdicts
  that suggest it.
  Reviewer-result is not fenced: any run with the grant records under its
  own run id, and the manager matches results to its reviewers by run id.
  Its body is a `StageResult` (`@corbits/triage-contracts`): the reviewer's
  kind (`code-review` or `judge`), the head it reviewed and its result, a
  code review's output or a judge's whole verdict, or `failed` with why it
  has none. The result is recorded by one statement only while its head is
  the newest one a pull request mail named, so no push slips between the
  check and the record; one for another head is dropped and logged as
  `reviewer_result_stale`. Otherwise, once recorded, the route wakes the pull
  request's manager as intake does for a host event (`createManagerWake`,
  `apps/hub/src/manager-intake.ts`): the live manager the claim names is
  mailed, or the host's listener is mailed the head to deploy one; a
  workspace with no listener logs `reviewer_result_unrouted`. A wake that
  fails leaves the result recorded and nothing else, is logged as
  `reviewer_result_wake_failed`, and answers 502 `wake_failed`; the next
  reconcile pass wakes a manager for it. Done records the reviewers the
  manager reports, then the hub stops each the claim holds on a head older
  than the newest, as one the pass deployed while a push arrived, the way
  intake does below.
- Pull request, waiting, held-Do approval and backlog mail goes to the
  host's listener (`apps/hub/src/manager-intake.ts`), on both hosts. Each
  pull request the mail names (a reconciler's `items`, a backlog's open pull
  requests) passes one gate first, whatever sent the mail: on GitHub, a pull
  request carrying the policy's pause label is dropped, and a policy file
  that writes its own `decide` leaves approve and merge to a person, since no
  workflow carries it out. The hub records one webhook event per pull request
  that passed, with the head's code review request when the policy turns
  code review on and the App's login on GitHub, then mails the listener the
  heads. Once it records a head, every judge or code review the claim still
  waits on for an older head of that pull request is stopped through the
  stock run lifecycle with the hub's own authority and then taken off the
  claim, each logged once as `reviewer_superseded`. A stop that fails is
  logged as `reviewer_supersede_failed` and leaves the reviewer on the claim;
  each triage reconcile pass stops the superseded reviewers of every claim
  again (`createSupersede`). When the host's head moved past the mail's, the event goes without
  a review request and the hub logs `code_review_head_moved`; the new head's
  own mail carries one. An event's id is the webhook's delivery id, which
  the coalescer's mail carries, so a redelivery records nothing new; any
  other mail is a new
  event, so a head mailed again, as after its base moved or its CI settled,
  is triaged again. A workspace with no live listener for the host mails
  nothing: Triage again, Review again, a held Do's approval and backlog
  triage answer 503 `service_not_running`, and a webhook's head fails, each
  saying Triage is not running on that host and that Settings → Triage shows
  why.
- Webhook replay protection uses the `@corbits/webhooks` table and a
  delivery-id cache in `HUB_DATA_DIR`.

## Vendoring

Interchange is vendored under `vendor/interchange` at a stock pin plus the
deltas in `vendor/interchange/VENDORED.md`, each with the condition for removing it.
`tooling/vendor-diff-check.sh` fails on any other drift, including a stock
file missing from the vendored copy unless `tooling/vendor-diff-pruned.txt`
lists it or a directory above it as an upstream path we don't vendor.
