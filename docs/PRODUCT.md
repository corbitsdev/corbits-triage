# Product

Corbits Triage triages GitHub pull requests. For every pull request on a
repository with triage on, it gathers facts from GitHub, runs the
repository's rules, decides Pass, Fail or Unsure, and suggests or runs the
steps the repository's policy lists for that verdict.

Nothing runs by default. Installing the GitHub App records repositories with
triage off; a repository is triaged only after someone turns on **Triage pull
requests in this repository** and saves. Draft pull requests are skipped
until they are marked ready for review, except for one run when one is
converted to draft. A pull request marked ready before any triage run also
wakes the policy as if it were opened.

## Who it is for

- **Maintainers** use the portal: verdicts, reasons and suggested actions
  for each open pull request.
- **Teams** share a workspace. Admins invite teammates by email; steps name
  GitHub users or teams for assignment and review.
- **Authors** see only what the repository's actions write on GitHub: labels,
  review requests, assignees and comments.

## What you see

- **Inbox**: open pull requests across repositories with triage on, in two views:
  Needs you and All open. Each opens a reading pane: one status
  line, the problems (failed rules, unsure answers, rules that could not
  run), the description, and folded rows for the linked issue, the changed
  files and the rules that passed. A bar at the bottom offers the next step
  for that state (merge, request changes, comment, reply, approve, close,
  triage again); the rest and the policy's actions are under More. Merging from the
  portal is pinned to the commit Triage checked. Needs you lists repositories
  with triage on; a pull request with a pending approval stays until it is answered.
  Every other open pull request (not triaged yet, waiting on the author, or
  already acted on) sits behind its **Waiting** filter, in the same list and
  pane, each marked with what it waits on. One that already needed you stays
  while Triage checks it again or waits for CI.
- **Pulse**: what changed since your last visit and what is stuck.
- **Repositories**: per repository, the triage switch and **Triage open pull
  requests again**, its policy file read back, code review, and the actions
  Triage takes on its own.
- **Settings**: the deployed workflow versions, the sources, the decision
  model and Anthropic keys (Models), invitations, workspace roles, the grid of
  action kinds by role, and the account.

A repository's panel is one scroll. The triage switch comes first; while it is
off, everything under it is dimmed and cannot be changed. Policy reads the
repository's `.corbits-triage.yml` back as sentences: each rule that is on,
then the steps for Pass, Fail and Unsure and whom each is for, with **Change on
GitHub** (or Bitbucket) linking the file. Rules and actions change only in the
file. Then Code review, and **Actions Triage takes on its own**: one switch per
action kind, from the grants in Settings → Access. Outcomes and **Remove
repository** close the panel.

The portal shows the verdict, its score and the reasons. Evidence for a file or a change
cites its changed lines (`src/router.ts:40-58`) and links them at the commit
that was judged. GitHub sees only the actions.

## Policy

Each repository has one policy: its rules, how they decide a verdict, the
steps that run for each verdict, and the verdict labels. It is stored as a
tenant artifact that the repository's record pins by id when the portal saves
it (until then, the newest artifact titled `check-pack/<owner>/<name>`), may
extend a workspace policy, and changes through the repository's policy file. The sections below follow it in that order.

## Rules

A rule answers one question about a pull request: pass, fail, or unconfirmed.
Each rule says how it is evaluated, in one of two kinds.

| Kind | Evaluates | Cost | Use it for |
| --- | --- | --- | --- |
| Rule | GitHub data only: files, size, linked issue, mergeability, reviews, CI. No inference. Built in only. | GitHub API calls. | Anything GitHub already knows. |
| Decision model | Fixed-shape questions to a System One model (Jev), citing the pull request as evidence. | One model request per batch of questions, billed by the model provider. | Judgment a rule cannot make: is the change focused, does it need docs. |

### Rules over GitHub data

Deterministic: the same pull request and policy give the same result. A rule is
unconfirmed only when GitHub has not computed what it needs yet, such as
mergeability or CI.

Built in: Max files changed, Max lines changed, Linked issue, No merge
conflicts, CI green, No forbidden paths. Two run on every pull request without
a switch: Not a draft (a draft is never ready) and No changes requested (a
requested change fails and waits on the author, then on the reviewer once the
author pushes or replies, until that reviewer reviews again). The recommended
forbidden paths are `vendor/**`, `node_modules/**` and `.github/**`: an author
who edits the workflows can change which checks run and turn CI green.

A custom rule is a decision-model rule (below) or a text rule. A text rule
fails when the title, the description or any commit message (the first 100,
read in full) contains one of its phrases, or with `not-contains` when one
contains none of them; phrases match without regard to case, and the evidence
quotes each matching line. The recommended policy has one on: fail when the
description or any commit message contains `Co-Authored-By:`, `Generated with`
or `Claude-Session:`. Who opened the pull request, whether it links an issue,
its CI and its size are a step's **when** conditions (see [Steps](#steps)), not
rules.

### Decision models

Each question has a fixed shape, so the answer is a calibrated probability or
a choice, never free text:

- **Is true**: a yes or no claim, asked of the whole pull request, of each
  changed file, or of each changed hunk, optionally only for paths matching
  globs.
- **Score**: which of 2 to 10 described levels, worst first, fits a subject.
  The level is shown in the portal and goes to the verdict question as
  evidence. It never fails the pull request unless **fail below** names a
  level.
- **Choose**: which of the policy's options best describes the pull request;
  it fails when that is one of the failing options.

Is true is one yes or no question, Score one Score question and Choose one
Choice question.

Built in: Focused (each change is classified against the primary
change) and Docs (each changed file is asked whether it needs docs;
changing a doc file satisfies the rule).

Answers are probabilities, and each rule decides only clear of a band
around a coin flip:

- **Is true, Docs**: yes at 0.7 or above, no at 0.3 or below. Docs asks per
  file; one file that needs docs fails the rule.
- **Score, Choose**: the likeliest level or option is the answer. With fail
  below set, a score fails when the levels below it hold 0.7 or more and passes
  when they hold 0.3 or less; a choice fails or passes the same way on the
  failing options.
- **Focused**: a change is unrelated at 0.6 or above for unrelated,
  and part of the change at 0.6 or above for the other choices combined.

Anything inside the band, a missing answer, or a failed model call leaves the
rule unconfirmed rather than guessed. A repository whose rules are all over GitHub data
never calls the model.

The model reads the pull request and the repository's docs from its default
branch. Custom rules also get the repository's contribution rules
(`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING`, the pull request template) and are
judged by them. How questions are asked, budgets, cost and measured accuracy
are in [DECISION_MODEL.md](DECISION_MODEL.md).

## Verdict

Each pull request head gets one verdict: **Pass**, **Fail** or **Unsure**.

- A hard rule (every built-in rule over GitHub data) that fails
  decides **Fail** without calling the model; the reasons list the failed rules.
- A policy with no decision-model rule on (no Focused, Docs, Is true, Score or
  Choose) never calls the model: every rule passing decides **Pass**, and any
  rule GitHub has not settled yet, such as pending CI, leaves it **Unsure**.
  The verdict's reason says the policy has no decision-model rule.
- A judged rule that fails decides **Fail** on its own answer, without the
  verdict question, so nothing the pull request says can talk it into a pass.
- Otherwise one decision model question decides: does this pull request pass
  this repository's policy? It reads every enabled rule with its result and
  evidence, the judged rules' answers with their probabilities, and the pull
  request's title, body, commits, paths and as much of its diff as fits one
  request. **Pass** at 0.7 or above for pass, **Fail** at 0.7 or above for
  fail, **Unsure** otherwise; a judged rule left unconfirmed turns a pass into
  **Unsure**. The score shown is the probability of pass.
- A draft or closed pull request is not decided. A model that does not answer
  leaves the verdict Unsure and Triage re-checks it.

Triage keeps one comment on the pull request: the verdict, the reasons (failed
hard rules first, then judged rules with their evidence), and what Triage did
or what waits on a maintainer. Its hidden marker records the head, the policy
versions and the verdict it was written for, and only the App's own comments
are read back, so a re-triage:

- writes nothing, not even an edit, when all three and the text are unchanged;
  the run records "unchanged since" the comment's last write;
- edits the comment in place and resyncs labels when the head moved or anything
  else changed;
- posts a new comment when only new policy versions changed the verdict on the
  same head, naming the versions, and edits the earlier one to "Superseded by
  the comment below".

Triage never writes to a closed or merged pull request: no comment, label or action.

## Steps

The policy holds one **When** and three ordered lists of steps: **On Pass**,
**On Fail** and **On Unsure**. The verdict picks the list. Each step names an
**action** and, optionally, **when** it runs.

- **When**: opened, updated, checks, ready; all four by default. Catching up
  runs the policy whatever it names.
- **On Unsure** asks CODEOWNERS for review by default.
- **Action**: approve, merge, close, comment, request changes, request review (from
  users, teams or code owners), assign, labels, or nothing. Settings → Access
  holds one grid, action kind by role: a role's people may approve held actions of the
  kinds it holds, and actions of the kinds Triage holds run on GitHub during
  triage; the rest wait in the Inbox for a click. New workspaces automate
  nothing.
- **When**: conditions that must all hold for the step to run, beside the
  verdict its list is for. Left out, the step runs for every pull request.
  - `author`: any of GitHub's author types (`OWNER`, `MEMBER`, `COLLABORATOR`,
    `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`,
    `MANNEQUIN`), `BOT` for a bot whatever its type, the members of a team
    (`{ team }`), or named people (`{ users }`). A policy written with the
    groups `maintainers` (`OWNER`, `MEMBER`, `COLLABORATOR`), `external`
    (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`,
    `MANNEQUIN`), `first-timers` (`FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`) or
    `bots` (`BOT`) reads each as exactly those types.
  - `linkedIssue`: true or false; an issue from GitHub or Linear, as the linked
    issue rule finds it, whatever tracker that rule names.
  - `ci`: any of passing, failing, pending or none.
  - `files` and `lines`: `{ over: N }`, `{ atMost: N }` or both; lines are
    additions plus deletions.

  A step whose conditions do not hold is skipped, and the verdict records it as
  skipped with why. One whose author GitHub cannot place, such as an unknown
  association or an unconfirmed team membership, is skipped too. The portal
  sets only the author; the other conditions are written in the policy file.
  A policy written before conditions named a step's author as `for`; it still
  reads, as that author alone.

In the policy file, under `actions` (`on` names the events, every one when left
out):

```yaml
actions:
  on: [opened, updated, checks, ready]
  pass:
    - do: approve
    - do: merge
      when: { author: [OWNER, MEMBER, COLLABORATOR], ci: [passing] }
  fail:
    - do: request-changes
    - do: close
      when: { author: [BOT, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER], lines: { over: 1000 }, linkedIssue: false }
  unsure:
    - do: request-review
      target: { to: codeowners }
```

Close never runs on its own on Unsure, and merge never runs on its own on
anything but Pass; a person holding the merge grant may still approve a held
merge from a Fail or Unsure list. Triage posts its comment when it holds Comment
and its verdict label when it holds Labels. Approve runs only on a Pass with CI
green. A merge waits, held with CI's state, until CI passes on the head, or runs
with no CI only when the policy switches CI green off (a policy that never
names CI green still requires CI); when it writes, it
reads CI and reviews again and refuses while CI has not passed or anyone has
requested changes; Triage's own standing request for changes is taken back
first. The repository's branch protection stays the backstop.
When the policy depends on CI (CI green is on, a step names a CI condition,
or a step approves or merges), Triage waits for CI to finish on the head, or
for its first check to fail, before it triages it, and the Inbox shows the
pull request as **Waiting for CI**. A pull request with an earlier result notes
new commits since Triage checked above it until the new result lands. A head
with no checks after 2 minutes is taken as having no CI, and none waits longer
than an hour. A run by hand does not wait. Meanwhile the pull request shows it
is waiting where Triage writes its verdict: the `Triage: Waiting for CI` label
on GitHub when the `pr-triage` role holds Labels, and the `Corbits Triage`
build status as in progress, "Triage: Waiting for CI", on Bitbucket when it
holds Comment. The verdict replaces it.
While CI is still running on a head triaged anyway, every action is held and
the comment says "Waiting for checks to finish". When the policy's When includes checks,
as it does by default, a completed check run has Triage triage the head again
and resolve the held actions.
Where Triage posts, a later head that may not be approved has the approve action's
approvals dismissed. Approvals made
from the Inbox are never dismissed. Request changes lists the failed rules the
author must fix, once per head; the automatic mirror dismisses it once none
still fails.

### Labels

Labels are the handoff: other tools, such as a coding agent, watch GitHub for
them and react through their own webhooks. Their names are stable:

| Label | When |
| --- | --- |
| `Triage: Ready` | The head passes. |
| `Triage: Not Ready` | The head fails. |
| `Triage: Needs Human Review` | The head is unsure. |
| `Triage: Waiting for CI` | Triage is waiting for the head's CI to finish before it decides; the verdict label replaces it. |
| `rule: <rule id>` | A built-in or custom rule that failed on the head, such as `rule: docs` or `rule: ci-green`. Not a draft and No changes requested get none. |

A head carries one verdict label at a time, written by Triage's mirror when the
`pr-triage` role holds Labels. A policy may name its own label for any verdict,
up to 50 characters, and the rest keep their defaults:

```json
"labels": { "pass": "Ready to ship", "fail": "Triage: Not Ready", "unsure": "Triage: Needs Human Review" }
```

The mirror takes back a verdict label that no longer applies: the three
defaults, the policy's own and the labels earlier versions set
(`Triage: Needs changes`, `Triage: Needs review`, `Triage: Ready to merge` and
the `triage:…` state labels). Rule labels come from a labels step,
`{ "do": "labels", "target": { "from": "rules" } }`, and like a fixed list of
labels it can be a step of any list and for any author. It takes back `rule: …`
for the built-in rules and the policy's custom rules that no longer fail; a
`rule: …` label naming no rule of the policy, and any other label, is the
repository's own. Both writers add and remove labels the same way, ignoring
case.

### Stored policies

Policies are `schemaVersion` 2. A version 1 policy, as earlier portals saved
one, still reads, as version 2, and the next save writes version 2: its actions
become steps for anyone, and actions that no longer run (agent, labels derived from
the type or paths), custom rules over GitHub data and text longer than version
2 allows are left out or cut, and every verdict's reasons name them. Only a
list of actions with branches, from before verdicts, cannot be read; an empty
one (`"actions": []`) reads as empty lists. Repository roles were removed: a
step whose target is a role is left out and named the same way.

Policy text reaches the decision model and GitHub, so names, claims, subjects,
levels, options, labels, teams and people are kept to one line (line breaks and
control characters become spaces), up to 500 characters, 50 for a label. A
comment keeps its line breaks and drops other control characters. A verdict
list holds at most 20 steps, and a list of labels, people or teams at most 50.

### Workspace policies

A repository's policy may extend a workspace policy. The workspace policy is a
default, not a floor: the repository may switch off or replace any of its
rules, its When, any verdict's steps and any verdict's label. Only a policy's
creator, the workspace's admins and its owners can change either policy.
Archiving a workspace policy does not stop it: repositories that extend it
keep using it.

Today a workspace policy is written through the hub's artifact route as an
artifact titled `workspace-policy/<name>`, and a repository policy extends it
by setting `extends` to that artifact's id. The portal shows an extending
policy resolved.

### Policy file

A repository may keep its policy in `.corbits-triage.yml` at the root of its
default branch (`.corbits-triage.yaml` is read when there is no `.yml`), so
policy changes are reviewed like code. The file lists its
`rules`, `actions` and `labels`, and may `extends` a workspace policy; any other
key is refused. Each rule is one sentence (`text`), how it is checked
(`check`: a built-in rule's id, `model` for a yes/no question the decision
model answers about the whole pull request, or `text` for a phrase match) and
why it exists: a one-line `reason` and its `evidence`, pull request references
(`#44`, `owner/name#44`), links or `maintainer-stated`. All four are required.
A built-in rule is named by its check; a model or text rule names its own `id`.
An empty `when` is refused rather than read as no condition.
A built-in rule takes its setting as `max` (size limits), `tracker` (linked
issue) or `paths` (forbidden paths); `enabled: false` keeps a rule written
down but off. Its JSON Schema is `policyFile` at the hub's
`/api/integrations/pack-schema`. Only YAML is read today, up to 64 KB and
without anchors or aliases. The GitHub Action in
[packages/policy-check-action](../packages/policy-check-action/action.yml)
checks the file the same way on pull requests that change it.

```yaml
rules:
  - check: max-lines-changed
    text: A pull request changes at most 400 lines.
    max: 400
    reason: Large changes were split before review.
    evidence: ["#44", "#57"]
  - id: errors-are-handled
    check: model
    text: Every new call that can fail handles or propagates its error.
    reason: Two outages came from swallowed errors.
    evidence: ["acme/api#312"]
  - id: no-attribution-trailers
    check: text
    text: Descriptions and commits carry no tool attribution.
    fields: [description, commits] # any of title, description, commits
    failWhen: contains # or not-contains
    phrases: ["Co-Authored-By:", "Generated with", "Claude-Session:"]
    reason: Maintainer-stated.
    evidence: [maintainer-stated]
```

A file without `rules` is read in the stored policy's shape (`checks`, `custom`,
`actions` with `when` events and `for` on steps), so files written before keep
working; score and choose rules and file or hunk scope exist only in that shape.

While the file is on the default branch it is the repository's policy, read
directly; a workspace policy it extends fills what it leaves out. Runs name the
file and its blob sha. A push to the default branch that changes the file (or
a forced push) is read before the next verdict, so the next triage uses the
new rules. A file triage refuses stops triage on the repository: nothing runs
and no step is taken until the file is fixed. Removing the file returns the
repository to the policy kept in Triage. A repository without the file is
untouched.

Rules saved in the portal before the file are moved into it, never dropped:

- **Upgrade.** A repository with saved rules and no file keeps running on the
  saved rules. Writing them to the file opens a pull request adding
  `.corbits-triage.yml` (schema 3, each rule with `reason: Set in the portal
  before the policy file.` and `evidence: [maintainer-stated]`); its
  description lists anything a file cannot hold (score or choice questions,
  file or hunk scope, a rule on without a value). The saved rules apply until
  it is merged.
- **Differs.** A repository whose file and saved rules run differently, or
  whose file Triage refuses, keeps running on the saved rules, so nothing a
  maintainer did not review starts or stops. Two ways out: a pull request
  making the file match the saved rules, or using the file, which archives
  the saved rules.
- **Matches.** Once the file and the saved rules run the same, the saved rules
  are archived and the file alone is the policy.

Wording, reasons and evidence never count as a difference; what each rule
checks and every step, in order, do. Every pull request goes on the
`corbits-triage/policy` branch: asking again updates the open one.

In the portal the repository's Policy section reads the file back, with
**Change on GitHub** (or Bitbucket). A refused file is shown with each problem
in the Policy section, and named above the Inbox. A repository with saved
rules to move shows one card in the Policy section, stepping through Review,
Open pull request, Merge on the host and Done: **Move this repository's rules
into a policy file** with **Open the pull request**; **Your policy file
differs from your saved rules** with each difference's saved and file values,
**Update the file to match** and **Use the file instead** (after confirming
what changes); the open pull request, re-read every 30 seconds until it
merges; or **Finish moving to the policy file** with **Use the file**. The
Repositories list marks it **Move rules to a file**, **Rules differ from
file**, **Waiting for merge** or **Switch to the file**, and the Inbox shows
the same words in one line. The same reads
and writes are hub routes: `GET …/github-triage/{tenantId}/policy/file`,
`GET …/policy/upgrades` and `POST …/policy/export`; using the file archives
the saved rules through the stock artifact route. `POST /api/integrations/policy/validate` takes a
file's text and the repository it is for, and answers the policy it holds or
each problem with the line of the rule or section it is in (the exact line and
column, for YAML errors); it needs no sign-in
and reads nothing else.

## Code review

A code review reads a pull request for defects: correctness bugs in the
changed lines and breakage the change causes elsewhere in the repository. Each
defect it reports names the line, why it is wrong, what triggers it and a fix,
with the code it points at. Every defect found is reported, the most severe
and most agreed-on first. A pull request with no defects gets one sentence on
what it changes.
It reviews GitHub and Bitbucket Data Center pull requests. Once code review
is on for a repository, every new commit of a pull request that is not a
draft is reviewed, and "Review again" reviews the current commit once more.
A diff over 100,000 characters is cut to its first lines, and the review says
how many it read. A workspace turns it on by saving an Anthropic key under
Settings → Models and switching it on per repository; each reviewed commit is
billed to the workspace's Anthropic account. Each review runs in an isolated
place of its own, apart from other work, because it checks out the pull
request's code. Until the server has one, the repository page shows a card
linking the setup guides in place of the switch, a repository left switched
on is not reviewed, and Settings → Models says code review can't run yet.
Findings show in the portal, in the pull request's reading pane, as the
first comment of a thread of their own. On a GitHub pull request, "Send to
GitHub" posts the newest finished review as one comment review by the Triage
App: findings on lines the diff shows are inline comments (one running past
its hunk names its other lines), the rest are in the review's text, as many
as fit GitHub's limit and then how many more the portal holds. It is posted
once per commit, never on its own, and not once the pull request has newer
commits; a newer commit's review is a review of its own beside the earlier
one. Sending needs only a finished review, so it works without an isolated
place.

## Triage over time

Turning triage on triages a repository's open pull requests; after that,
pull request events are triaged as they arrive, and the hub re-queues any
open pull request whose latest commit has no verdict. A pull request merged
into the default branch makes the repository's other open pull requests due
again, each at most once per 15 minutes. A re-check reuses the decision
model's earlier answers for anything unchanged. See
[ARCHITECTURE.md](ARCHITECTURE.md#workflows).

## Not finished

- The repository scan measures a repository's closed pull requests but does
  not propose a policy yet, and the hub does not run it.
- Code review runs only where the hub has Docker; there is no cloud
  provisioner yet.
- Code review's findings are not sent to Bitbucket Data Center pull requests.
