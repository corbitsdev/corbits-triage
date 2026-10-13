# Product

Corbits Triage triages GitHub pull requests. For every pull request on a
repository with triage on, it gathers facts from GitHub, runs the
repository's checks, reaches a verdict, and suggests or runs the actions the
repository defines.

Nothing runs by default. Installing the GitHub App records repositories with
triage off; a repository is triaged only after someone turns on **Triage pull
requests in this repository** and saves.

## Who it is for

- **Maintainers** use the portal: verdicts, reasons and suggested actions
  for each open pull request.
- **Teams** share a workspace. Admins invite teammates by email; roles in a
  repository's policy name GitHub users or teams for assignment and review.
- **Authors** see only what the repository's actions write on GitHub: labels,
  review requests, assignees and comments.

## What you see

- **Inbox**: open pull requests across repositories with triage on, in three views:
  Needs you, All open and First-timers. Each opens a reading pane: one status
  line, the problems (failed checks, unsure answers, checks that could not
  run), the description, and folded rows for the linked issue, the changed
  files and the checks that passed. A bar at the bottom offers the next step
  for that state (merge, request changes, comment, reply, approve, close,
  triage again); the rest and the pack's Dos are under More. Merging from the
  portal is pinned to the commit Triage checked.
- **Pulse**: what changed since your last visit and what is stuck.
- **Repositories**: per repository, its checks, its actions, its roles,
  whether Triage posts automatically or asks first, the merge score threshold,
  a preview against an open pull request, recent stats, the triage switch and
  **Triage open pull requests again**.
- **Settings**: the deployed workflow versions, the GitHub App, the decision
  model, invitations, workspace roles and access rules, and the account.

The portal shows the score and the reasons. Evidence for a file or a change
cites its changed lines (`src/router.ts:40-58`) and links them at the commit
that was judged. GitHub sees only the actions.

## Checks

A check answers one question about a pull request: pass, fail, or unconfirmed.
Each check says how it is evaluated. There are three kinds; two exist today.

| Kind | Evaluates | Cost | Use it for |
| --- | --- | --- | --- |
| Rule | GitHub data only: files, diff, title, branch, labels, reviews, CI, author. No inference. | GitHub API calls. | Anything GitHub already knows. |
| Decision model | Fixed-shape questions to a System One model (Jev), citing the pull request as evidence. | One model request per batch of questions, billed by the model provider. | Judgment a rule cannot make: is the change focused, does it need docs. |
| Agent | Planned, not built. | | |

### Rules

Deterministic: the same pull request and pack give the same result. A rule is
unconfirmed only when GitHub has not computed what it needs yet, such as
mergeability or CI.

Built in: Size, Linked issue, Merge conflicts, CI, Forbidden paths. Two run on
every pull request without a switch: a draft is never ready, and a requested
change waits on the author.

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

Built in: Focused change (each change is classified against the primary
change) and Docs (each changed file is asked whether it needs docs;
changing a doc file satisfies the check).

Answers are probabilities, and each check decides only clear of a band
around a coin flip:

- **Is true, Score, Choose, Docs**: yes at 0.7 or above, no at 0.3 or
  below. Docs asks per file; one file that needs docs fails the check.
- **Focused change**: a change is unrelated at 0.6 or above for unrelated,
  and part of the change at 0.6 or above for the other choices combined.

Anything inside the band, a missing answer, or a failed model call leaves the
check unconfirmed rather than guessed. A repository whose checks are all rules
never calls the model.

The model reads the pull request and the repository's docs from its default
branch. Custom checks also get the repository's contribution rules
(`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING`, the pull request template) and are
judged by them. How questions are asked, budgets, cost and measured accuracy
are in [DECISION_MODEL.md](DECISION_MODEL.md).

## Actions

An action is **When → Checks → Yes / No / Unsure → Dos**:

- **When**: every event, or chosen ones (opened, updated, ready, commented,
  reviewed, approved, checks, closed, merged and so on). Catching up runs
  every action.
- **Checks**: the checks whose combined verdict picks the branch. Any
  unconfirmed check makes it Unsure. With no checks, the action always runs.
- **Dos**: labels, assign, request review, comment, approve, request changes,
  convert to draft, close, agent. Each Do
  has its own automatic flag: automatic Dos run on GitHub during triage, the
  rest wait in the Inbox for a click.

Close never runs automatically on Unsure or without checks. Approve runs only
for a head that is ready to merge with CI green; in a repository that posts
automatically, a later head that may not be approved has the approve Do's
approvals dismissed. Approvals made from the Inbox are never dismissed.
Request changes lists only the failed checks the author must fix, once per
head; the automatic mirror dismisses it once none still fails.

## Triage over time

Turning triage on triages a repository's open pull requests; after that,
pull request events are triaged as they arrive, and the hub re-queues any
open pull request whose latest commit has no verdict. A pull request merged
into the default branch makes the repository's other open pull requests due
again, each at most once per 15 minutes. A re-check reuses the decision
model's earlier answers for anything unchanged. See
[ARCHITECTURE.md](ARCHITECTURE.md#workflows).

## Not finished

- Agent checks and agent Dos: the pack format accepts agent Dos, but they
  cannot run yet.
- Sidecars run on the hub's own machine; there is no remote provisioner yet.
