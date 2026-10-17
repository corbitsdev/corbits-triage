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
    `.corbits-triage.yaml` syncs the policy file. Signatures are checked by
    the X-Hub-Signature verifier in `@corbits/common/x-hub-signature`, the
    same scheme `@corbits/webhooks` 0.4 adds as `verify: "x-hub-signature"`
    (`sha256=` and the hex HMAC of the raw body, the header names taken from
    `metadata.webhook.headers`). Every writer of the GitHub and Bitbucket
    hook credentials (hub and portal) builds that metadata from
    `@corbits/common/hook-metadata`; the bridges do not read it yet, and
    credentials written with `standard-webhooks` keep working.
    Temporary until the hub runs `@corbits/webhooks` 0.4, which is the next
    step: release the package, then fold the bridges into the coordinator.
  - **Policy file sync**: a repository may keep its policy in
    `.corbits-triage.yaml` on its default branch. A sync reads the file (its
    `rules` mapped onto the stored policy's built-in rows and custom rules, or
    a file in the stored policy's shape as is) and stores it as a new version
    of the repository's policy, marked with its blob sha, so triage keeps
    reading the hub's copy. A step's `when` conditions are evaluated in the
    workflow's action step against the facts it already reads. A push or
    `POST …/github-triage/{tenantId}/policy/sync` runs a sync.
    `GET …/policy/file` reads the file and whether the policy matches it.
    `POST …/policy/export` opens a pull request adding the file from the
    stored policy.
  - **Coalescer**: one pull request's burst of webhook events goes out as one
    mail to the tenant's live pr-triage deployment for the repository's host
    (`pr-triage-github` or `pr-triage-bitbucket-datacenter`), as the tenant
    system sender, the same path cron uses. The mail names the host as
    `repoSource`. A new commit or a newly opened pull request waits only a few
    seconds.
  - **Reconciler**: on an interval, compares each enabled repository's open
    pull requests with the run logs and stored state, and re-queues every
    head without a verdict, and every stale head at most once per 15 minutes,
    in batches and under a per-tenant in-flight cap. A catch-up mail carries
    the decision-model answers recorded in the head's last verdict (from its
    run log) when the deployment runs the
    same workflow version and decision-model offering. One reconciler runs
    per host over that host's repositories and deployment. It also replaces a
    pr-triage deployment with a fresh copy once its run log grows past a
    limit, and redeploys one that Interchange failed, after two minutes and
    at most three times an hour.
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
    policy schemas, invitations, and workflow deploy and versions.
    `GET /api/integrations/github-triage/{tenantId}/policy?repo=` answers a
    repository's policy as triage reads it, and
    `POST /api/integrations/github-triage/{tenantId}/backlog` starts backlog
    triage, so only the hub resolves policies and builds trigger mail.
    Each is described in `/openapi.json`. Pull request
    actions are synchronous: a maintainer's click must not wait on a
    workflow spin-up.
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`. Today it runs local child processes and restores
  them on boot; a remote provisioner replaces it without touching other code.
- **Portal** (`apps/web`): owns setup. After sign-in it converges the tenant,
  GitHub credentials, inference offering, workflow sources and deployments
  over stock hub routes. The hub seeds nothing for it. It is a wrapper over
  the routes; nothing is possible only through it.

## Workflows

Each is an `onTrigger` mail listener: each mail spawns a child run that
executes and ends.

- `pr-triage-github` and `pr-triage-bitbucket-datacenter`: one mail names one
  pull request, or a batch of heads from the reconciler, and triages them.
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
   the head settles, so the reconciler does not retry it. When the policy's
   When includes checks, as it does by default, the completed `check_run`
   webhook triages the head again and resolves the held actions; a Bitbucket
   head is polled for its build statuses instead.
7. **mirror**: writes the default verdict label (`Triage: Ready`, `Triage: Not Ready` or `Triage: Needs Human Review`) when the
   `pr-triage` role holds the labels grant, and one marker comment when it holds the comment grant; on Bitbucket the comment
   grant also writes the verdict as the `Corbits Triage` build status. It runs before execute so a merge or close finds the final verdict on the head it closes.
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
   group, ending with its agreement. A group the model leaves without a
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
  the repositories extending it. The portal shows such a policy resolved and
  refuses to save over it. Each trigger mail names what its pack was resolved
  from under `policy.source` (`{ repo: { id, version }, shared?: { id,
  version } }`), read when the event was accepted, so a run records which
  versions it used.
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
