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

- **Inbox**: open pull requests across repositories with triage on, in three views:
  Needs you, All open and First-timers. Each opens a reading pane: one status
  line, the problems (failed rules, unsure answers, rules that could not
  run), the description, and folded rows for the linked issue, the changed
  files and the rules that passed. A bar at the bottom offers the next step
  for that state (merge, request changes, comment, reply, approve, close,
  triage again); the rest and the policy's Dos are under More. Merging from the
  portal is pinned to the commit Triage checked.
- **Pulse**: what changed since your last visit and what is stuck.
- **Repositories**: per repository, its Size, Checks and Judgement rules,
  the steps for each verdict, its labels, the triage switch and **Triage open
  pull requests again**. Every change saves on its own.
- **Settings**: the deployed workflow versions, the GitHub App, the decision
  model, invitations, workspace roles, the grid of Do kinds by role, and the
  account.

A repository's panel is one scroll. The triage switch comes first; while it is
off, everything under it is dimmed and cannot be changed. Three cards hold the
rules: Size, Checks and Judgement, each rule a sentence with a switch, its
values inline while it is on, and how often it passed this week. Under Checks
a line notes what always runs: drafts wait until they are ready for review,
and a pull request with changes requested fails. Then lists the steps for each
verdict: what each does, whom it is for, and whether it runs on its own
(automatic) or waits for you, from the grants in Settings → Access. The Labels
card names each verdict's label and switches a label for each failed rule. The
header says Saved, Saving… or Not saved; a step or rule that is not filled in
yet says what it needs and is not saved until it is.

The portal shows the verdict, its score and the reasons. Evidence for a file or a change
cites its changed lines (`src/router.ts:40-58`) and links them at the commit
that was judged. GitHub sees only the actions.

## Policy

Each repository has one policy: its rules, how they decide a verdict, the
steps that run for each verdict, and the verdict labels. It is stored as a
tenant artifact that the repository's record pins by id when the portal saves
it (until then, the newest artifact titled `check-pack/<owner>/<name>`), may
extend a workspace policy, and is edited on the Repositories page. The sections below follow it in that order.

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
requested change waits on the author). The recommended forbidden paths are
`vendor/**`, `node_modules/**` and `.github/**`: an author who edits the
workflows can change which checks run and turn CI green.

Custom rules are decision-model rules only (below). Who opened the pull request
is a step's **for** (see [Steps](#steps)), not a rule.

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

Triage never writes to a closed or merged pull request: no comment, label or Do.

## Steps

The policy holds one **When** and three ordered lists of steps: **On Pass**,
**On Fail** and **On Unsure**. The verdict picks the list. Each step names a
**Do** and who it is **for**.

- **When**: opened, updated, checks, ready; all four by default. Catching up
  runs the policy whatever it names.
- **On Unsure** asks CODEOWNERS for review by default.
- **Do**: approve, merge, close, comment, request changes, request review (from
  users, teams or code owners), assign, labels, or nothing. Settings → Access
  holds one grid, Do kind by role: a role's people may approve held Dos of the
  kinds it holds, and Dos of the kinds Triage holds run on GitHub during
  triage; the rest wait in the Inbox for a click. New workspaces automate
  nothing.
- **For**: the pull request's author, who opened it and never changes: anyone
  (the default), first-timers, maintainers (owner, member or collaborator),
  external (contributor, first-timer or outside), bots, the members of a team,
  or named people. A step not for the author is skipped, and the verdict
  records it as skipped with why. One whose author GitHub cannot place, such
  as an unknown association or an unconfirmed team membership, is skipped too.

In the policy artifact, `for` may be left out for anyone:

```json
"actions": {
  "when": ["opened", "updated", "checks", "ready"],
  "pass": [
    { "do": "approve" },
    { "do": "merge", "for": "maintainers" },
    { "do": "request-review", "target": { "to": "teams", "teams": ["acme/ledger-maintainers"] }, "for": "first-timers" }
  ],
  "fail": [
    { "do": "request-changes" },
    { "do": "labels", "target": { "from": "rules" }, "for": { "team": "acme/core" } }
  ],
  "unsure": [
    { "do": "request-review", "target": { "to": "codeowners" } },
    { "do": "close", "for": "bots" }
  ]
}
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
Where Triage posts, a later head that may not be approved has the approve Do's
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
one, still reads, as version 2, and the next save writes version 2: its Dos
become steps for anyone, and Dos that no longer run (agent, labels derived from
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
policy resolved but cannot edit it yet.

### Policy file

A repository may keep its policy in `.corbits-triage.yaml` at the root of its
default branch, so policy changes are reviewed like code. The file holds what
the stored policy holds, without `kind`, `schemaVersion` and `repo`; it may
`extends` a workspace policy; any other key is refused. Its JSON Schema is
`policyFile` at the hub's `/api/integrations/pack-schema`. Only YAML is read
today, up to 64 KB and without anchors or aliases.

The file becomes the repository's policy; a workspace policy it extends fills
what it leaves out. A push to the default branch that changes the file (or a
forced push) stores it as a new version of the repository's policy, marked
with the file's blob sha, and runs name that file; a file that is not a valid
policy is logged and changes nothing. Removing the file keeps the policy as it
was, no longer marked as from the file. A repository without the file is
untouched.

In the portal the repository's Policy card links the file and says when it
was synced; the rules, steps and labels are then read-only, with **Edit on
GitHub**. When the hub's copy differs from the file it says **Not in sync**,
and **Use file** reads the file now. A repository without the file can
**Export to repository**: the hub opens a pull request adding the file from
the current policy on the `corbits-triage/policy` branch. The same reads and
writes are hub routes: `GET …/github-triage/{tenantId}/policy/file`, and
`POST …/policy/sync` and `…/policy/export`.

## Triage over time

Turning triage on triages a repository's open pull requests; after that,
pull request events are triaged as they arrive, and the hub re-queues any
open pull request whose latest commit has no verdict. A pull request merged
into the default branch makes the repository's other open pull requests due
again, each at most once per 15 minutes. A re-check reuses the decision
model's earlier answers for anything unchanged. See
[ARCHITECTURE.md](ARCHITECTURE.md#workflows).

## Not finished

- Sidecars run on the hub's own machine; there is no remote provisioner yet.
