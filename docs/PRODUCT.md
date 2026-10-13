# Product

Corbits Triage triages GitHub pull requests. For every pull request on a
repository with triage on, it gathers facts from GitHub, runs the
repository's rules, decides Pass, Fail or Unsure, and suggests or runs the
actions the repository's policy lists for that verdict.

Nothing runs by default. Installing the GitHub App records repositories with
triage off; a repository is triaged only after someone turns on **Triage pull
requests in this repository** and saves. Draft pull requests are skipped
until they are marked ready for review, except for one run when one is
converted to draft. A pull request marked ready before any triage run also
wakes the policy as if it were opened.

## Who it is for

- **Maintainers** use the portal: verdicts, reasons and suggested actions
  for each open pull request.
- **Teams** share a workspace. Admins invite teammates by email; roles in a
  repository's settings name GitHub users or teams for assignment and review.
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
- **Repositories**: per repository, its rules, how the verdict is decided,
  its actions, its roles, a preview against an open pull request, recent
  stats, the triage switch and **Triage open pull requests again**.
- **Settings**: the deployed workflow versions, the GitHub App, the decision
  model, invitations, workspace roles and access rules, and the account.

The portal shows the verdict, its score and the reasons. Evidence for a file or a change
cites its changed lines (`src/router.ts:40-58`) and links them at the commit
that was judged. GitHub sees only the actions.

## Rules

A rule answers one question about a pull request: pass, fail, or unconfirmed.
Each rule says how it is evaluated. There are three kinds; two exist today.

| Kind | Evaluates | Cost | Use it for |
| --- | --- | --- | --- |
| Rule | GitHub data only: files, diff, title, branch, labels, reviews, CI, author. No inference. | GitHub API calls. | Anything GitHub already knows. |
| Decision model | Fixed-shape questions to a System One model (Jev), citing the pull request as evidence. | One model request per batch of questions, billed by the model provider. | Judgment a rule cannot make: is the change focused, does it need docs. |
| Agent | Planned, not built. | | |

### Rules over GitHub data

Deterministic: the same pull request and policy give the same result. A rule is
unconfirmed only when GitHub has not computed what it needs yet, such as
mergeability or CI.

Built in: Max files changed, Max lines changed, Linked issue, No merge
conflicts, CI green, No forbidden paths. Two run on every pull request without
a switch: Not a draft (a draft is never ready) and No changes requested (a
requested change waits on the author).

Custom rules: paths unchanged, paths changed together, title pattern, branch
pattern, required label, diff excludes a pattern, minimum approvals, and
author (users, a role, or kinds such as first-timer or bot).

### Decision models

Each question has a fixed shape, so the answer is a calibrated probability or
a choice, never free text:

- **Is true**: a yes or no claim, asked of the whole pull request, of each
  changed file, or of each changed hunk, optionally only for paths matching
  globs.
- **Score**: whether a subject reaches a minimum on a 0 to 10 scale.
- **Choose**: whether the pull request is best described by a passing option
  rather than a failing one.

Score and Choose are each asked as one yes or no question.

Built in: Focused (each change is classified against the primary
change) and Docs (each changed file is asked whether it needs docs;
changing a doc file satisfies the rule).

Answers are probabilities, and each rule decides only clear of a band
around a coin flip:

- **Is true, Score, Choose, Docs**: yes at 0.7 or above, no at 0.3 or
  below. Docs asks per file; one file that needs docs fails the rule.
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

- A hard rule (every rule above, built in or custom, except author) that fails
  decides **Fail** without calling the model; the reasons list the failed rules.
- Otherwise one decision model question decides: does this pull request pass
  this repository's policy? It reads every enabled rule with its result and
  evidence, the judged rules' answers with their probabilities, and the pull
  request's title, body, commits, paths and as much of its diff as fits one
  request. **Pass** at 0.7 or above for pass, **Fail** at 0.7 or above for
  fail, **Unsure** otherwise. The score shown is the probability of pass.
- A draft or closed pull request is not decided. A model that does not answer
  leaves the verdict Unsure and Triage re-checks it.

Triage posts one comment per head: the verdict, the reasons (failed hard rules
first, then judged rules with their evidence), and what Triage did or what
waits on a maintainer.

## Actions

The policy holds one **When** and three lists of Dos: **On Pass**, **On Fail**
and **On Unsure**. The verdict picks the list.

- **When**: opened, updated, checks, ready; all four by default. Catching up
  runs the policy whatever it names.
- **On Unsure** asks CODEOWNERS for review by default.
- **Dos**: labels, assign, request review, comment, approve, request changes,
  close, agent. Settings → Access holds one grid, Do kind by role: a role's
  people may approve held Dos of the kinds it holds, and Dos of the kinds
  Triage holds run on GitHub during triage; the rest wait in the Inbox for a
  click. New workspaces automate nothing.

Close and agent Dos never run on their own on Unsure. Triage posts its comment
when it holds Comment and its labels when it holds Labels. Approve runs only
on a Pass with CI green; where Triage posts, a later head that may not be
approved has the approve Do's approvals dismissed. Approvals made from the Inbox are never dismissed.
Request changes lists the failed rules the author must fix, once per head; the
automatic mirror dismisses it once none still fails.

Policies saved before verdicts read as one policy: each action's yes Dos join On
Pass, no Dos On Fail, unsure Dos On Unsure and Dos without rules all three, except close and agent, which join On Unsure only; an action woken by no event the policy names is dropped;
repeated Dos run once and When is every action's together.

## Triage over time

Turning triage on triages a repository's open pull requests; after that,
pull request events are triaged as they arrive, and the hub re-queues any
open pull request whose latest commit has no verdict. A pull request merged
into the default branch makes the repository's other open pull requests due
again, each at most once per 15 minutes. A re-check reuses the decision
model's earlier answers for anything unchanged. See
[ARCHITECTURE.md](ARCHITECTURE.md#workflows).

## Not finished

- Agent rules and agent Dos: the policy format accepts agent Dos, but they
  cannot run yet.
- Sidecars run on the hub's own machine; there is no remote provisioner yet.
