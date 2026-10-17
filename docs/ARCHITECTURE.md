# Architecture

Triage is an app on [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, grants, credentials, workflow runs and
audit. Triage is a hub composition, a client-driven portal, and the workflow
and tool packages the portal deploys.

## Components

```
GitHub ──webhook──► Hub ──spawn──► Sidecar ──► pr-triage run
   ▲                 │  ▲                          │
   │                 │  └──── portal (/api) ───────┤
   └─── PR actions ──┴──── GitHub reads, actions ──┘
```

- **Hub** (`apps/hub`): the stock Interchange hub plus one composition
  block: `@corbits/webhooks` at `/api/hooks`, `@corbits/artifacts`,
  `@corbits/cron`. In the image it also serves the built portal, so one
  origin carries the portal, the API and GitHub webhooks. Triage adds:
  - **GitHub bridge**: verifies GitHub's HMAC on `/api/hooks/*`, updates the
    tenant's repository list from installation events, and hands pull
    request, review, comment and `check_run` events to the coalescer. A pull
    request merged into the default branch marks the repository's other
    triaged heads `stale`. A push to the default branch that touches
    `.corbits-triage.yml` or `.corbits-triage.yaml` reads the policy file
    again. Signatures are checked by
    the X-Hub-Signature verifier in `@corbits/common/x-hub-signature`, the
    same scheme `@corbits/webhooks` 0.4 adds as `verify: "x-hub-signature"`
    (`sha256=` and the hex HMAC of the raw body, the header names taken from
    `metadata.webhook.headers`). Every writer of the GitHub and Bitbucket
    hook credentials (hub and portal) builds that metadata from
    `@corbits/common/hook-metadata`; the bridges do not read it yet, and
    credentials written with `standard-webhooks` keep working.
    Temporary until the hub runs `@corbits/webhooks` 0.4, which is the next
    step: release the package, then fold the bridges into the coordinator.
  - **Policy file**: a repository may keep its policy in
    `.corbits-triage.yml` (or `.corbits-triage.yaml`, read when the first is
    absent) on its default branch. When the file is there, every trigger
    mail, preview and portal read takes the policy from it (its `rules`
    mapped onto the stored policy's built-in rows and custom rules, or a file
    in the stored policy's shape as is), naming the file and its blob sha as
    the source; the stored policy is read only when there is no file. While a
    repository has both and they run differently (compared rule by rule and
    step by step, never as text), or the file is refused, the stored policy
    applies until the file matches it or the maintainer archives it; once both
    run the same, the hub archives the stored policy and the file alone is
    the policy. A file triage refuses with no stored policy is `invalid`: no
    mail is sent and nothing runs until it is fixed. The hub keeps each
    repository's read in memory, nothing stored; a push to the default branch
    that touches the file (GitHub `push`, Bitbucket `repo:refs_changed`)
    reads it again, and a failed read is not kept, so the next trigger reads
    the file itself. A step's `when` conditions are evaluated in the
    workflow's action step against the facts it already reads.
    `GET …/policy/file` reads the file and why it is refused, if it is.
    `POST /api/integrations/policy/validate` (open, reads only its body)
    checks a file's text and answers each problem with its line.
    `GET …/policy/upgrades` answers, for each enabled repository, `upgrade`
    (stored policy, no file), `differs` (with the differences in plain words)
    or `ok`. `POST …/policy/export` writes the stored policy as a schema 3
    file on `corbits-triage/policy`, at the existing file's path when there is
    one, and opens a pull request through the GitHub App or the Bitbucket
    Data Center token listing what the file cannot hold; asking again updates
    the open pull request.
  - **Coalescer**: one pull request's burst of webhook events goes out as one
    mail to the tenant's live pr-triage deployment for the repository's host
    (`pr-triage-github` or `pr-triage-bitbucket-datacenter`), as the tenant
    system sender, the same path cron uses. The mail names the host as
    `repoSource`. A new commit, an opened, reopened or ready pull request, an
    approval or a change request waits only a few seconds; comments, other
    chatter and check events wait the quiet period. When the policy depends on
    CI (CI green is on, a step has a `ci` condition, or a step approves or
    merges), a head whose CI is still running is not mailed: its row in the
    triage state turns `waiting` and keeps the window's events
    (`triage_waiting_ci`). The window that sees CI finish, or its first check
    fail, mails the head once with those events. A head with no checks yet
    waits up to 2 minutes for CI to start, and no head waits more than 60
    minutes from when it was first seen. Manual runs, the backlog
    run and retries after the base branch moves are not held. When a head
    starts waiting, and the `pr-triage` role holds Labels on GitHub or Comment
    on Bitbucket, the hub also mails it once with `kind: "waiting"`: the run
    triages nothing and only mirrors the waiting marker (see step 7).
  - **Reconciler**: on an interval, compares each enabled repository's open
    pull requests with the run logs and stored state, and re-queues every
    head without a verdict, and every stale head at most once per 15 minutes,
    one head per job, under a per-tenant in-flight cap. It reads the CI of every
    `waiting` head and queues it once CI finished or its wait ran out, in a
    mail of its own with the events it waited with; this releases Bitbucket
    heads, whose builds send no webhook, and any head whose `check_run` never
    arrived. A head it finds with no webhook behind it, such as an open pull
    request when triage is turned on, waits the same way while its CI runs,
    and is mailed to be marked waiting the same way. Moving a head from `waiting` to `queued` is a compare-and-swap
    write, so a check run and the reconciler releasing it together start one
    run. A catch-up mail carries
    the decision-model answers recorded in the head's last verdict (from its
    run log) when the deployment runs the
    same workflow version and decision-model offering. One reconciler runs
    per host over that host's repositories and deployment. It also replaces a
    pr-triage deployment with a fresh copy once its run log grows past a
    limit, and redeploys one that Interchange failed, after two minutes and
    at most three times an hour.
  - **Coordinator**: every triage mail (webhook, retry, reconciler) and
    every code review mail is a job in one in-memory queue keyed per workflow
    and pull request. Each job runs in a worker deployment of its own, copied
    from the host's live deployment, which only seeds workers, and released
    once its run ends. How many run at once is the provisioner's call: a
    placement it declines for want of room, or a job with no live deployment
    to copy yet, waits and is retried with backoff.
  - **Run recorder**: reads the live logs of tenants with a pr-triage run in
    flight and records each verdict and executed action.
  - **App Manifest conversion**: GitHub returns a one-time code that must be
    exchanged server side, so the private key never reaches the browser. The
    `state` round-tripped through GitHub is signed by the hub and bound to the
    user who started setup, so no setup state is stored.
  - **Integration routes** under `/api/integrations/`: sign-in methods,
    GitHub App setup and installation sync, open pull requests, details,
    actions, held actions, previews (API only; the portal no longer calls it) and single
    pull request triage, latest verdicts, triage stats and timeline, the
    policy schemas, invitations, workflow deploy and versions, and the
    per-repository code review switch.
    `GET /api/integrations/github-triage/{tenantId}/policy?repo=` answers a
    repository's policy as triage reads it, and
    `POST /api/integrations/github-triage/{tenantId}/backlog` starts backlog
    triage, so only the hub resolves policies and builds trigger mail.
    Each is described in `/openapi.json`. Pull request
    actions are synchronous: a maintainer's click must not wait on a
    workflow spin-up.
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`. The local-process provisioner runs child processes
  on the hub's machine and restores them on boot. The Docker provisioner
  (`packages/provisioner-docker`), registered after it when a Docker daemon
  with the sidecar image answers, runs each sidecar in a container of its own
  and declares `isolation:workload`; workflows that require it land there, and
  probes then require it too, so no probe runs on the hub's machine. Its
  containers get 2 GiB each, which is also what each counts against the
  daemon's memory ([measurements](provisioners/docker.md#memory)).
  [provisioners/](provisioners/README.md) describes both.
  The local provisioner declines a new sidecar while free memory, less one
  footprint for each sidecar it started that has not connected yet, is below
  one more footprint. Free memory is the container's cgroup limit less its
  usage, reclaimable page cache counted free (v2, else v1), else Linux's
  `MemAvailable`. A box with neither, such as a macOS dev machine, never
  declines. The footprint is 1 GiB: on a local stack (2026-10-17, macOS,
  GitHub emulator) four pr-triage-github workers peaked at 793, 784, 852 and
  860 MiB RSS over a full run, and idle listeners held 471 to 653 MiB. A
  sidecar connects with about half its peak in use, so a burst right after
  can still overshoot the free figure by that much. A failed deployment whose
  copy is declined is tried again on the reconciler's short retry, not the
  next interval.
- **Portal** (`apps/web`): owns setup. After sign-in it converges the tenant,
  GitHub credentials, inference offering, workflow sources and deployments
  over stock hub routes. The hub seeds nothing for it. It is a wrapper over
  the routes; nothing is possible only through it.

## Workflows

Each is an `onTrigger` mail listener: each mail spawns a child run that
executes and ends.

- `pr-triage-github` and `pr-triage-bitbucket-datacenter`: one mail names one
  pull request and triages it.
  Both are built by `prTriage({ sources })` in `@corbits/triage-workflows`.
  Each binds only its host's credential, since an unresolved binding fails a
  deployment, so a workspace deploys one per connected host. A deployment of
  the earlier `pr-triage` workflow is released once `pr-triage-github` is
  live.
- `pr-triage-historical`: one run that triages every open pull request of a
  repository, skipping drafts. The hub mails it through its backlog route when
  a user turns triage on for the repository, or clicks **Triage open pull
  requests again**, and records its verdicts as it does pr-triage's; the
  reconcilers never mail or rotate it.
- `repo-scan`: one run that reads a repository's most recently updated closed
  pull requests (200 by default) and measures what maintainers merged and closed. Its
  `history` step is pr-triage's facts director with `kind: "history"`: it
  lists closed pull requests a page at a time, then reads each one's facts,
  without patches, ten at a time; one whose reviews, commits or checks it
  cannot read is left unread rather than counted as empty. The `measure` action turns them into one
  record per pull request and merged-against-closed counts per signal. It is
  not deployed by the hub yet; proposing rules, replaying them and opening the
  policy pull request come next.

- `pr-code-review-github` and `pr-code-review-bitbucket-datacenter`
  (`@corbits/pr-code-review-anthropic`): one mail names one pull request
  (title, description, diff, and the host, repository and head sha to read)
  and the run returns a review: a summary and comments anchored to lines.
  Both are built by `prCodeReview({ sources })` and bind only their host's
  read credential. Nothing mails them or posts their review yet.

The bridge and the reconciler find the target by workflow name per tenant; no
deployment ids are configured anywhere.

## Triage pipeline

Every run is the same steps; the repository's policy decides what each
one does.

1. **facts**: reads the pull requests, their files, reviews, CI, commits (the
   first 100 messages in full), the repository's docs and its contribution
   rules from GitHub.
2. **rules**: runs the hard rules (the built-in rules over GitHub data and
   the policy's text rules) and, unless one failed or the pull request
   is a draft or closed, builds the judged rules' questions; with none left
   to ask, it builds the verdict question instead.
3. **route**: skips the judge when no question needs asking.
4. **judge**: one System One call per request of questions that no carried
   answer matches. The only step that infers; see
   [DECISION_MODEL.md](DECISION_MODEL.md).
5. **parts**: reads the first answers and asks, through a second judge map,
   one question per file of each slice that failed focused and the verdict
   question over every rule's result.
6. **evaluate**: decides the verdict: Fail on a failed hard rule, Pass when every rule passes in a policy with no decision-model rule, otherwise
   Pass, Fail or Unsure from the verdict question. It renders the one comment
   and resolves the verdict's list of steps when the policy's When is woken, skipping each step not for the pull request's author.
   While CI is pending, every runnable action is held and an approve that may
   not stand is skipped. The comment says "Waiting for checks to finish" and
   the head settles, so the reconciler does not retry it. A policy that
   depends on CI meets this only when its head was released by the wait's
   limit or run by hand; others are triaged at once. When the policy's
   When includes checks, as it does by default, the completed `check_run`
   webhook triages the head again and resolves the held actions. The
   reconciler also re-reads the CI of such a head on the unconfirmed retry
   interval and queues it once CI changed, finding the verdict among the
   recorded ones as well as the live logs, so a verdict given by a deployment
   since replaced still counts, which covers Bitbucket, whose
   builds send no webhook, and a check run whose event was lost or failed to
   mail.
7. **mirror**: writes the default verdict label (`Triage: Ready`, `Triage: Not Ready` or `Triage: Needs Human Review`) when the
   `pr-triage` role holds the labels grant, and one marker comment when it holds the comment grant; on Bitbucket the comment
   grant also writes the verdict as the `Corbits Triage` build status. It runs before execute so a merge or close finds the final verdict on the head it closes.
   A waiting mail from the hub's sender skips every other step: the `waiting` action and `held` gate route it to `markWaiting`,
   which mirrors only the waiting marker under the effect id `waiting:<owner>--<name>:<number>:<head sha>`: the
   `Triage: Waiting for CI` label in place of the verdict label on GitHub, or the `Corbits Triage` build status as
   `INPROGRESS` "Triage: Waiting for CI" on Bitbucket. Both writes are no-ops when the head already shows them, and
   nothing is written once the pull request moved past the head the mail named. The
   verdict's own mirror replaces it: the waiting label is one of the labels it owns and takes back, and the build status
   is overwritten under the same key.
8. **execute**: runs the actions whose kind the `pr-triage` role holds on the host.
   Every other action is held in the verdict (`held: true`) and the run finishes.

The hub reads which kinds the `pr-triage` system role is granted, `invoke` on
`triage-do:<kind>:<owner>/<name>`, and mails them with each trigger; the run
trusts them only from the hub's sender. Close on an Unsure verdict, and merge on anything but Pass,
are always held. The hub mails the policy twice: `pack` as resolved from the repository policy and any workspace policy it extends, and `checkPack` in the shape a deployment built before steps reads, without the steps it would run wrongly. At start the hub
grants the role comment and labels on each repository still set to post
automatically, then drops that setting. A person holding the same grant approves a held action, or one the run failed or could
not write, from the inbox: the hub checks the grants below and mails the
deployment the action, its effect id, head and approver. That mail skips triage: an
`approval` action step reads it, trusting only the hub's sender and checking the
effect id, and execute writes the action unless GitHub already shows it; a close, merge,
comment or review is refused once the head has moved. The hub reads the
approval run's outcome back onto the verdict that held the action. "Hide for me"
hides an action in that browser only; nothing is sent.

Rules, routing, approval and evaluation are deterministic `action` steps. Facts,
execute and mirror reach GitHub through the GitHub tool's credential, so on
this Interchange pin they run as directors until actions can reach a bound
credential. Downstream work on a pull request is its own workflow, never a
step here.

## Code review pipeline

Code review is switched on per repository through
`POST /api/integrations/code-review/{tenantId}`, which needs the host
connected and the workspace's Anthropic key. The portal then deploys that
host's `pr-code-review-<host>` with an offering for each model it names
(Opus 5.5 for the diff finder, Haiku 5.5 elsewhere). The hub releases a
host's code review once none of its repositories has it on, the host is
disconnected or the key is gone. Each new non-draft head of a pull request
in such a repository (opened, reopened, a push, marked ready) is mailed to it
once, whether or not triage is on; it runs in a worker of its own, keyed
apart from the pull request's triage.
`POST /api/integrations/code-review/{tenantId}/run` reviews the current head
again. The hub sends the host's unified diff (on GitHub, built from the
files' patches when the pull request is too large for GitHub's diff), cut at
a line boundary past 100,000 characters, with `cut: { lines, of }`, which the review carries.
Code review only reads: its tools are the
host read bundle and the confined repository reads, so it stays on the
local-process sidecar.

The pipeline looks for defects with two finders, groups what they report by
defect and reports every group, ordered so the most severe and most agreed-on
come first. Steps that call a model take their effort from the request.

1. **plan**: names the risky changed areas and the code outside the diff they
   depend on.
2. **findDiff** and **findRepo**, in parallel: the diff finder reads the diff
   in one call. The repository finder checks the head out into the step's
   working tree with the host bundle's `*_checkout` and reads it with the
   confined `read_file`, `grep` and `list` tools until its budget of billable
   tokens is spent; a review whose reader ran out says it stopped early.
3. **candidates** (action): folds exact duplicates (same file, overlapping
   lines, same first line of quoted code) into one finding that remembers
   which finders reported it and how many times.
4. **consolidate**: its director reads the lines each finding cites at the
   head through the host's `*_read_file` and moves the finding onto the line
   its quoted code names; then one model call groups the findings that
   describe the same defect. A finding left out of every group is a group of
   its own, and groups whose findings land on the same line with the same
   first quoted line once moved are joined.
5. **check**, only when the request sets `check`: one call per group, over
   its representative and the lines read around it; only `real` verdicts go
   on. It is off by default: on 42 held-out public pull requests with known
   bugs it raised precision from 35.8 to 51.9 but cut recall from 60.9 to
   40.6, for an F1 of 45.6 against 45.1 without it (see the eval README).
6. **write**: the groups in order of severity (the most severe priority a
   finder gave) and then agreement (how many finders reported it, then how
   many findings it stands for): a summary of the change and one comment per
   group, with the code it quotes and its agreement as fields. A group the model leaves without a
   comment gets one from the finder's title, explanation, trigger and quoted
   code.

The structured steps (plan, consolidate, check, write) answer against a JSON
schema. Checkout and file reads reach the host through its bound credential,
so, as with triage's facts step, they run in directors. The eval and its
numbers are in `packages/pr-code-review-anthropic/evals/README.md`.

## Tenancy and authority

A user's workspace is an Interchange tenant; repositories are tenant config
(`corbitsTriage.repos`) plus a per-repository policy and triage state,
both stored as tenant artifacts. Runs act under the grants materialized for
their deployment. GitHub access is a tenant credential bound to the GitHub
tool packages: the vault holds the App as `{"appId","privateKey"}` under
provider `github` and its webhook secret under provider `github-hook`. A
trusted sidecar adapter turns the App key into short-lived
installation tokens at the fetch boundary, so workflow and tool code never
hold it. Hub routes that read GitHub check the caller's `read` (or `use`)
grant on the same credential; routes that write to GitHub check `use`. Reads
(open pull requests, details, and the API-only preview) use the secret on the caller's
behalf and never return it; writes are pull request actions and triage; approving a held action checks only its kind's grant.
A pull request action from the portal of a kind triage can run (comment, labels,
assign, request review, approve, request changes, close, merge) also checks `invoke`
on `triage-do:<kind>:<owner>/<name>`, the repository name in lowercase; the
admin role holds `triage-do:*` from GitHub setup, and owners hold every grant.
A member given the `pr-triage` role is refused every action until it is removed,
so what triage does unattended never becomes what a person may do. In a run, the repository's policy decides when to
approve, and only a head that passes with CI green is approved, from the
newest verdict. Where triage mirrors and its policy approves, a settled head
that may not be approved dismisses the approvals the approve action made; one
dismissed on a head is not made again on it. Where it does not mirror, its
approvals are not dismissed.
Hub routes that reach GitHub for the portal use the same adapter.

## Data

- Interchange's own tables, artifacts and run logs hold tenants, credentials,
  deployments and runs.
- Artifacts: the policy and the triage state (`triage-state/{owner}/{repo}`)
  per repository. The policy is the artifact the repository's record pins by
  id (`checkPack.id`), which the portal writes when it saves the policy; a
  repository not saved since pins existed, or whose pinned policy is
  archived, falls back to the newest artifact titled `check-pack/{owner}/{repo}`.
  Reading writes nothing. The triage state holds each open head's status
  (`new`, `queued`, `running`, `triaged`, `failed`, `stale`) and attempts.
  Each new artifact is writable and archivable by its creator and the admin
  role, and owners hold every grant; at start the admin role is granted the
  same on policies made before.
- Workspace policies (`workspace-policy/{name}`) have a policy's shape without
  a repository, and the stock artifact list finds them with
  `?query=workspace-policy/`. A repository policy that sets `extends` to one's
  artifact id is resolved over it whenever it is read (`resolvePolicy`):
  built-in rules merge field by field per rule id, so a repository row with
  `enabled: false` switches a shared rule off and one that sets only a limit
  keeps the shared switch; a repository custom rule replaces the shared one of
  the same id whole and the rest follow the shared ones, at most eight
  together; `when`, each verdict's steps and each verdict's label come from
  the repository only when it sets them. A workspace policy is a default, not a floor: an override
  may switch off or replace any of it, and only the policies' creators, admins
  and owners can write either. An archived workspace policy still applies to
  the repositories extending it. The portal shows such a policy resolved. Each
  trigger mail names what its pack was resolved from under `policy.source`
  (`{ repo: { id, version }, shared?: { id, version } }`), read when the event
  was accepted, so a run records which versions it used.
- Triage tables, in the `corbits_triage` schema: `verdict` (verdicts per
  head, with the outcomes of the actions their run executed), applied from `apps/hub/migrations` at hub start in one
  transaction under an advisory lock. Nothing else is stored: the GitHub App
  setup state is a signed token, and an invite is a stock invited principal
  the invitee accepts once signed in with a verified address, by a
  better-auth magic link when the hub sends email.
- Webhook replay protection uses the `@corbits/webhooks` table and a
  delivery-id cache in `HUB_DATA_DIR`.

## Vendoring

Interchange is vendored under `vendor/interchange` at a stock pin plus the
deltas in `vendor/interchange/VENDORED.md`, each with a kill date.
`tooling/vendor-diff-check.sh` fails on any other drift.
