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
    with no stored policy is `invalid`: no mail is sent. Routes:
    `GET …/policy/file` (the file and why it is refused),
    `POST /api/integrations/policy/validate` (open, reads only its body),
    `GET …/policy/upgrades` (`start`, `upgrade`, `differs` or `ok` per enabled
    repository) and `POST …/policy/export`, which opens or updates one pull
    request on `corbits-triage/policy` writing the stored policy, or the
    starter policy for `start`, as a schema 3 file. For a repository with
    no file, no stored policy and no policy pull request open it can
    instead write a chosen `text`, refused when triage would refuse it once
    merged, `extends` resolved.
  - **Coalescer**: one pull request's burst of webhook events goes out as one
    mail to the tenant's live pr-triage deployment for the repository's host,
    as the tenant system sender, the same path cron uses, naming the host as
    `repoSource`. When the policy depends on CI, a head whose CI is still
    running is not mailed: its triage-state row turns `waiting` and keeps the
    window's events (`triage_waiting_ci`). The window that sees CI finish, or
    its first check fail, mails the head once with those events; a head with
    no checks waits up to 2 minutes, and none waits more than 60. Manual runs,
    the backlog run and retries after the base branch moves are not held.
    When a head starts waiting and the role holds Labels (GitHub) or Comment
    (Bitbucket), the hub also mails it once with `kind: "waiting"`, which only
    mirrors the waiting marker.
  - **Reconciler**: one per host. On an interval it compares each enabled
    repository's open pull requests with the run logs and stored state, and
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
    together start one run. A catch-up mail carries the decision-model
    answers from the head's last verdict when the deployment runs the same
    workflow version and decision-model offering. It also replaces a pr-triage
    deployment once its run log grows past `TRIAGE_ROTATE_AFTER_RUNS`, and
    redeploys one Interchange failed, after two minutes and at most three
    times an hour.
  - **Coordinator**: every triage mail (webhook, retry, reconciler) and every
    code review mail is a job in one in-memory queue keyed per workflow and
    pull request. Each job runs in a worker deployment of its own, copied from
    the host's live deployment, which only seeds workers, and released once
    its run ends. How many run at once is the provisioner's call: a placement
    it declines for want of room, or a job with no live deployment to copy
    yet, waits and is retried with backoff. A worker the sender gate refuses
    (a copy of a deployment made before its workflow declared who may mail
    it) is released and its job retried the same way five times, enough for
    the portal reload after a hub deploy; then the head fails with "this
    repository's Triage deployment is out of date; open the portal to
    redeploy it", and the reconciler queues it again after the redeploy. The queue, like the coalescer's
    windows, lives in memory, so the hub runs as one replica. A restart loses
    only queue order: the hub releases orphaned workers on start and the
    reconciler queues their heads again.
  - **Run recorder**: reads the live logs of tenants with a run in flight and
    records each verdict and executed action.
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
    `GET …/github-triage/{tenantId}/policy?repo=` answers a repository's
    policy as triage reads it, with the merge risks of its automatic approve
    or merge computed there, which the portal shows for GitHub repositories, and `POST …/github-triage/{tenantId}/backlog`
    starts backlog triage, so only the hub resolves policies and builds
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
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`s. The local-process provisioner runs child processes
  on the hub's machine, restores them on boot and declines a placement while
  free memory is short. The Docker provisioner (`packages/provisioner-docker`),
  registered after it when a daemon with the sidecar image answers, runs each
  sidecar in a container of its own and declares `isolation:workload`;
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
  one. While it is null the switch and **Review again** refuse
  (`no_isolated_place`), nothing is mailed, the host's code review
  deployments are released, and the portal links Settings → Code review in
  place of the switch.
- **Portal** (`apps/web`): owns setup. After sign-in it converges the tenant,
  credentials, inference offerings, workflow sources and deployments over
  stock hub routes. The hub seeds nothing for it. It is a wrapper over the
  routes; nothing is possible only through it. Each minute and on focus it
  reads the served `index.html`; once its hashed entry script differs from the
  one the tab loaded, it offers a reload, since a stale tab would deploy the
  workflows of the build it runs.

## Workflows

Each is an `onTrigger` mail listener: each mail spawns a child run that
executes and ends. The bridge and the reconciler find the target by workflow
name per tenant; no deployment ids are configured anywhere. Each declares
`mailAccept: { tenant: true }`, so Interchange's sender gate admits the hub's
`github` sender (a principal in the deployment's tenant) and refuses mail from
any other tenant or an unknown sender.

- `pr-triage-github` and `pr-triage-bitbucket-datacenter`: one mail names one
  pull request and triages it. Both are built by `prTriage({ sources })` in
  `@corbits/triage-workflows`. Each binds only its host's credential, since an
  unresolved binding fails a deployment, so a workspace deploys one per
  connected host. A deployment of the earlier `pr-triage` workflow is released
  once `pr-triage-github` is live.
- `pr-triage-historical`: one run that triages every open pull request of a
  GitHub repository, skipping drafts. The hub mails it through its backlog
  route when triage is turned on, when a push to the default branch changes the
  policy file of an enabled repository and leaves it valid, or when someone clicks **Triage open pull requests
  again**, and records its verdicts like pr-triage's.
- `repo-scan`: one run that reads a repository's most recently updated closed
  pull requests (200 by default) and measures what maintainers merged and
  closed. Not deployed by the hub yet.
- `pr-code-review-github` and `pr-code-review-bitbucket-datacenter`: one mail
  names one pull request and the run returns a review.
- `pr-workflow-anthropic-github` and `pr-workflow-anthropic-bitbucket-datacenter`:
  triage, then code review behind a gate, in one run ([PR workflow](#pr-workflow)).
  The portal deploys a host's while a repository's policy file needs it; the
  hub picks it per pull request.

## Triage pipeline

Every run is the same steps; the repository's policy decides what each one
does. Before facts, a pull request mail from the hub naming a GitHub head
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
   With the regression-risk rule on, it also lists each changed file's
   default-branch commits from the last 30 days (`github_list_path_commits`,
   `bitbucket_datacenter_list_path_commits`, one page each, ten files at a
   time; tests, docs and lockfiles skipped) and keeps how many have a subject
   typed fix, bugfix, hotfix or revert (`fixes`); a history that fails or
   runs past one page is kept as unread, which leaves only that rule
   unconfirmed.
2. **rules**: runs the hard rules (built-in rules over host data, text
   rules and code-pattern rules) and, unless one failed or the pull request is a draft or closed,
   builds the judged rules' questions, or the verdict question when there are
   none.
   A code-pattern rule runs its presets' ast-grep rules and its own (its own
   win on a shared id) with `@ast-grep/napi` over each changed TypeScript or
   JavaScript file's head content, and keeps matches on lines the patch adds.
   A file whose patch or content was not read, or a rule ast-grep refuses,
   leaves the rule unconfirmed; vendored, installed, built and generated
   paths are skipped, and a `?? 0` inside arithmetic is a counter's real
   default. With such a rule on, the facts step reads each file whose patch
   adds lines at the head through the host's `read_file` (`whole`), runs the
   rules there and outputs only the matches. Bitbucket Data Center lists no
   patch, so there the rule is unconfirmed. The extension leaves code-pattern rules out and swaps the native module
   for a stub.
3. **route**: skips the judge when no question needs asking.
4. **judge**: one System One call per request of questions that no carried
   answer matches. Each first-round request also asks whether the pull
   request's text, diff or docs try to direct the judge; a confident yes in
   any of them leaves every judged rule unconfirmed and the verdict Unsure,
   without the verdict question. The only step that infers; see
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
   instead of waiting.
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
trusts them only from the hub's sender. Close on Unsure, and merge on anything
but Pass, are always held. The hub mails the policy twice: `pack` as resolved
from the repository policy and any workspace policy it extends, and `checkPack`
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

`POST /api/integrations/code-review/{tenantId}` switches code review on per
repository; it needs the host connected and a code review provider's key. A
workspace runs one provider, the one whose key it stores in Settings → Code
review
(`CODE_REVIEW_PROVIDERS` in `triage-contracts`; only Anthropic today). The
portal deploys that host's `pr-code-review-<host>` from the provider's
package, and the hub releases it once no repository has code review on, the
host is disconnected or the key is gone.

Each new non-draft head of a pull request in such a repository is mailed once,
whether or not triage is on, with the host's unified diff cut at a line
boundary past 100,000 characters; on GitHub a diff too large for the diff API
is built from the files' patches. The files a cut leaves unread, read from the
diff's headers, ride as `cut.unread` and never reach a prompt; the review sent
to GitHub lists them. The title and description are read as the facts step
reads them (`shownBody` and `visibleText` in `@corbits/triage-contracts`), so
hidden text never reaches the review. `…/run` reviews the current head again.
Code review only reads: a checkout action downloads the head through the host
credential to `<SIDECAR_DATA_DIR>/checkouts/<host>/<owner>/<repo>/<sha>`, and
its tools are the host read bundle and repository reads confined to that
folder. The consolidate step reads each finding's lines at the head and reports
the findings it could show the model no line of; a comment whose group had no
member read carries `unverified`, which the portal and the review sent to
GitHub show as "Not checked against the file".

Beside the model steps, two steps read what tools already say, as structured
findings (source, rule, path, line, message, severity, fix when the tool gives
one) for a fix workflow to take later; nothing is sent on yet. `lint` runs the
oxlint the sidecar image pins over the changed files with the repository's own
`.oxlintrc.json`, nested configs off, and keeps hits on added lines. Only data
keys pass (rules, categories, built-in plugins, env, globals, settings,
ignorePatterns, overrides of the same); a config with any other key (`extends`,
`jsPlugins`, `options` among them) or one that is code (`oxlint.config.*`) is
refused unrun. The kept keys are written to a config outside the checkout, and
the files follow `--`. A repository with no config is not linted. `ciAnnotations` reads
the head's GitHub check-run annotations or Bitbucket Data Center Code Insights
annotations through the host credential, under the checkout's effect
capability. A lint or a read that fails is `incomplete`, never an empty list.

Each request carries `diffHash`, a SHA-256 of the full diff, `index` lines
included, so a base change to a file the diff touches, or a binary change,
changes it. A diff with no `index` line, as GitHub's rebuilt from the file
list, is sent unhashed. The hash lives in the run log, so carrying over works
after a restart: a new head whose diff hashes the same as the newest review's,
when that review finished, is not mailed but takes the review over (`carries`
in `code-review-runs.ts`). `GET …/code-review` with `head` answers `carriedTo`,
reading that head's diff once; a failed read is not retried for five minutes.
The review is then sent to GitHub at that head, unless it was sent on its own,
whose comments stay on the same lines. A diff that can't be read and `…/run`
review the head instead.

A pull request's reviews are read from the run logs. A failed run's reason is
a fixed sentence for why its first step that failed for good did
(`failureReason` in `pr-code-review`); the run log keeps the error itself.

Sending a review to GitHub is a person's write through
`POST /api/integrations/github-actions/{tenantId}` (`action: "code-review"`,
the Comment grant): the hub reads the newest finished review from the run logs
and posts it as one `COMMENT` review pinned to its head. The review's marker
and `commit_id` are its effect id, so the App's marked review of that head is
found before anything is written.

The steps, the provider profile and how to add a provider are in
[packages/pr-code-review/README.md](../packages/pr-code-review/README.md); the
eval and its numbers in
[packages/pr-code-review-anthropic/evals/README.md](../packages/pr-code-review-anthropic/evals/README.md).

## PR workflow

`@corbits/pr-workflow-anthropic` composes the two pipelines into one
definition per host. Its steps are pr-triage's under their own ids, then code
review's (`codeReviewSteps` in `pr-code-review`) under `codeReview_`, whose
actions read their steps under the `$prefix` their input carries.

Once triage has decided, `codeReview_scope` reads the trigger request's
`codeReview` (`on`, `for`, the `triage` verdicts it runs on, `rules`, optional
`paths` globs, where `*` stays within one folder and `**/` matches zero or more
folders, and the block's optional `clean`) and `codeReviewRequest`, triage's
verdict, the changed files and, unless `for` holds `everyone`, the author's
groups from the pack's `groups` and triage's facts. Whatever the scope cannot
read leaves the review incomplete. Under `rules: pass`, the hub's default
unless the block's `when.rules` is `any`, `rulesGate` in `triage-contracts`
keeps the review shut unless every policy rule in the verdict's `checks` read
without a model whose failure fails the pull request passed (`hardFailures`,
shared with triage), CI only through `ci-green` and never the built-in
`not-a-draft` or `no-changes-requested`:
a failed one skips it, and one not known yet, such as CI still running, or no
checks leaves it incomplete; the hub triages again once CI completes. The gate
is a plain function so a coordinator that starts code review as its own
workflow can apply it unchanged. A gate runs the review or skips it, and
`codeReview` records the outcome: `findings` with the worst that counts,
`clean`, `skipped` with the reason, or `incomplete` when the scope or a review
step failed, the review cannot be read, the reader stopped early, the diff was
cut, or a paths rule met unread files. A finding counts unless its severity is
below `clean.below`.

`decide` is the run's one decision. It reads the trigger request's `decide`
(the policy file's rules; the parser writes a file's `actions` as one rule per
triage outcome, and with a block on, approve and merge only under
`{ all: clean }`, the other steps kept in their places in a second rule) and
`blocks` (the blocks the policy turns on), triage's verdict, the events that
woke the run, the author's groups
(`authorGroupsOf` over the pack's `groups`) and code review's outcome, whose
findings' priorities read as severities (0 critical, 1 high, 2 medium, 3 low;
any other, or none, critical), as does a worst it cannot read. Rules run in order and the first that matches
wins; skipped blocks never count, so `{ all: clean }` holds when every block
that ran is clean. Every block with an outcome counts, whatever
`blocks` says, and one that is on, or that a rule names, with no outcome reads
as `incomplete`: this variant runs only code review, so `security` or
`deslop` on is incomplete here. It flags for a maintainer when nothing
matches, when the rules are missing or invalid, when a rule names groups and
the author's cannot be read, and when a matched rule approves or merges after
an incomplete block. Only
`decide` chooses: with any block in `blocks`, the verdict comment names no Do,
so it never claims an approve or merge `decide` may hold.

The matched rule's own steps, with their targets and `when`, become the Dos,
resolved, held and granted as triage's own (`suggestedDos` in pr-triage's
evaluate); the labelling rules' labels Do runs as triage adds it, whatever is
decided. Every other Do the verdict would have run unattended is recorded
`held` with the reason (on a flag, the flag; otherwise the block that was not
clean, such as "Code review is findings"), which the hub reads as a Do triage
held, so it waits in Needs you and its approval mail runs triage's own
execute. So a schema 3 file's approve and merge wait for a maintainer after a
review that was not clean. Stock runs a step whose dependencies failed, so ordering
alone holds nothing back: triage's execute is one step after the mirror and
`decide`, and without a decision it fails and writes nothing. An approval or waiting mail never triages, so it never reaches the
scope. The definition binds both pipelines' credentials and, like code review,
requires `isolation:workload`.

The hub picks the workflow per mail, wherever the mail came from
(`github/pr-workflow.ts`). A policy file needs the PR workflow when it turns a
block on or its `decide` is not the one the parser derives from its `actions`;
only then does the stored policy keep its v4 keys, and its pull request mails
carry `codeReview`, `blocks` and `decide`. Such a `pr` mail goes to the host's
variant for code review's `provider`, else the first provider in the default
order whose key is stored; only credential names are read. With code review
on, the hub reads the diff, through the repository record the job carries,
into `codeReviewRequest`, and leaves it out when the head moved or the read
failed, so the review is incomplete. The mail runs in a worker copied from the
variant's listener, like pr-triage's. Without that key, with a block on that
the variant does not run (`security`, `deslop`), or with no live variant
listener, pr-triage runs it with approve and merge taken out of `automatic`,
so they wait in Needs you, and the hub logs `pr_workflow_unavailable`. Saved
rules carry no v4 keys, so they always run pr-triage.

The coordinator keeps one triage job per pull request whichever workflow it
names, so a newer head's job replaces a queued one and a deferred job a newer
head replaced is dropped. In a repository the PR workflow reviews, the file
alone decides code review: the standalone feed skips it, and the code review
switch and "Review again" refuse with `policy_file_decides`. A host's
pr-triage observer also reads its variants' workers, so their runs settle its
heads, and reads a run's Dos from `decide`: the Dos it made, then evaluate's it
did not make that wait, those `decide` left held with its reason and those
evaluate held itself, such as for a missing grant. A held Do's approval goes to
the listener of the workflow whose run held it; with that listener released,
the approval is refused. The portal deploys a variant while a connected
repository's policy file needs it (`prWorkflow` on the code review place
route) and the provider's key is stored, redeploys it with the key or the
decision model, and releases it once no repository needs it or either is
removed; the hub releases it once its host is disconnected or code review has
no place to run. The separate `pr-code-review` deployments still run beside
it.

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
per-IP limit, which cannot resolve a client behind a proxy. Stock has no unverified state of its own: tenant creation gives any
signed-in user an active owner membership, and the stock tenant middleware
refuses only inactive memberships, so it covers neither `/api/me` nor tenant
creation.

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
`github` is moved to `github-app` when the hub next reads the key: the next worker deploy, portal read, installation sync or token loop pass, so at most 45 minutes later; until then that credential holds App JSON and a deployment launched from it is handed the key. The hub
mints the token before it deploys a GitHub worker (when under 15 minutes are
left) and renews it on boot and every 45 minutes. Every write holds the
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
worker deploys with it. The next good renewal sets it `active` again; running
deployments still re-resolve an expired credential, as stock drops only
revoked ones.
Hub routes that reach GitHub for the portal sign with the App key on the hub.
Each GitHub mail names the App's bot account (`<slug>[bot]`, the slug GitHub
answers for `GET /app`, refreshed on every renewal) as `appLogin`, and only
that account's comments and reviews are triage's own. Routes that read the host check the caller's `read`
(or `use`) grant on `github` and never return a secret; routes that write
check `use`. A pull request action of a kind triage can run also checks
`invoke` on `triage-do:<kind>:<owner>/<name>` (the repository name in
lowercase); the admin role holds `triage-do:*` from GitHub setup, and owners
hold every grant. A member given the `pr-triage` role is refused every action
until it is removed, so what triage does unattended never becomes what a person
may do. Approving a held action checks only its kind's grant.

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
  artifact the repository's record pins by id (`checkPack.id`), else the
  newest titled `check-pack/{owner}/{repo}`. The triage state holds each open
  head's status (`new`, `queued`, `waiting`, `running`, `triaged`, `failed`,
  `stale`) and attempts. Each new artifact is writable and archivable by its
  creator and the admin role.
- Workspace policies (`workspace-policy/{name}`) have a policy's shape without
  a repository. A repository policy whose `extends` names one is resolved over
  it whenever it is read (`resolvePolicy`): built-in rules merge field by
  field, custom rules by id (at most eight together), and `when`, each
  verdict's steps and each verdict's label come from the repository only when
  it sets them. An archived workspace policy still applies. Each trigger mail
  names the versions its pack was resolved from under `policy.source`.
- A policy file whose `extends` is a repository name is resolved the same way
  over that repository's policy file, read through the same per-repository
  cache, at the time the policy is read; `policy.source.sharedFile` names the
  file and its blob. A push or merge to the shared repository refreshes its
  cache entry, so no dependent is tracked. A Bitbucket repository that is not
  enabled has no triage webhook, so its file is kept for a minute instead.
- Triage's tables, in the `corbits_triage` schema: `verdict` (verdicts per
  head, with the outcomes of the actions their run executed) and
  `device_code` (better-auth's device authorization, for agents a signed-in
  person approves), migrated from `apps/hub/migrations` at hub start in one
  transaction under an advisory lock. Nothing else is stored: GitHub App setup
  state is a signed token, and an invite is a stock invited principal.
- Webhook replay protection uses the `@corbits/webhooks` table and a
  delivery-id cache in `HUB_DATA_DIR`.

## Vendoring

Interchange is vendored under `vendor/interchange` at a stock pin plus the
deltas in `vendor/interchange/VENDORED.md`, each with a kill date.
`tooling/vendor-diff-check.sh` fails on any other drift.
