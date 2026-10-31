# Product

Corbits Triage triages pull requests on GitHub and Bitbucket Data Center. For
every pull request on a repository with triage on, it gathers facts from the
host, runs the repository's rules, decides Pass, Fail or Unsure, and suggests
or runs the steps the repository's policy lists for that verdict.

Nothing runs by default. Connecting a host records repositories with triage
off; a repository is triaged only after someone turns on **Triage pull requests
in this repository**, and only once its policy has a rule. Drafts are skipped
until they are marked ready for review, except for one run when a pull request
is converted to draft. A pull request marked ready before any triage run wakes
the policy as if it were opened.

How to use the portal, screen by screen, is in the
[user manual](Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md).

## Who it is for

- **Maintainers** use the portal: verdicts, reasons and suggested actions for
  each open pull request.
- **Teams** share a workspace. Admins invite teammates by email; steps name
  users or teams for assignment and review.
- **Authors** see only what the repository's actions write on the pull
  request: labels, review requests, assignees, comments, and on Bitbucket a
  build status.

## What you see

- **Triage**: the page you land on after you sign in (a workspace with no
  repositories lands on **Repositories**). One list, with **Needs you**,
  **Waiting**, **Ready** (passed on the latest commit, CI passed, no conflicts,
  oldest first), **Open** and **All** (every open pull request across the repositories
  Triage runs on). A row is a state mark and the
  title, then the number (with the repository's name unless grouped by
  repository), a short status, the author when grouped by repository, and its
  age. Each opens a reading pane: the status line, which says what the bar's
  main button does and which rules it is about (the row says the same,
  shortened), the problems (failed rules, unsure answers and rules the policy
  asks a maintainer about, rules that could not run, each named, then why),
  the description, and folded rows for the linked issue, the changed files and
  the rules that passed (**Checked and fine**). A bar at the bottom offers the
  next step; merging from the portal is pinned to the commit Triage checked.
  Without a decision model, a card at the top links to Settings → Triage to add one.
- **Repositories**: per repository, the triage switch and **Triage open pull
  requests again**, its policy file read back as sentences, where code review
  runs when the server has no place for it (the policy file turns code review
  on), the actions Triage takes on its own, and outcomes before and after
  Triage.
- **Audit**: at `/audit`, not linked from the menu: the latest events the
  workspace recorded, newest first: verdicts and the actions their runs took,
  held action approvals, members, grants and workflow deployments.
- **Settings**: Triage (sources, policy files, the decision model key, and
  whether Triage takes the actions each policy file names on its own), Code review (the
  provider's key and where reviews run), people and invitations, the account,
  and each host's listener version for support. Roles and grants change only through
  the hub routes.

The portal shows the verdict, its score and the reasons. Evidence for a file
cites its changed lines (`src/router.ts:40-58`) and links them at the commit
that was judged. The pull request sees only the actions.

## Rules

A rule answers one question about a pull request: pass, fail, or unconfirmed.

| Kind | Evaluates | Cost | Use it for |
| --- | --- | --- | --- |
| Rule | Host data only: files, size, linked issue, mergeability, reviews, CI, text. No inference. | Host API calls. | Anything the host already knows. |
| Decision model | Fixed-shape questions to a System One model (Jev), citing the pull request as evidence. | One model request per batch of questions, billed by the model provider. | Judgment a rule cannot make: is the change focused, does it need docs. |

Rules over host data, decision-model rules and [code review](#code-review) are
three separate parts, each with its own limits. Rules over host data read
every changed file's patch up to a ceiling of their own, however much of the
diff the decision model's budget leaves out, and code review cuts its own
diff. A limit one part reaches never changes what another reads.

### Rules over host data

The same pull request and policy give the same result. A rule is unconfirmed
only while the host has not computed what it needs, such as mergeability or CI.

Built in: Max files changed, Max lines changed, Max lines changed per file, Max additions, Max deletions (lockfiles left out of the GitHub counts; on Bitbucket Data Center the per-file rule always passes, and lockfile lines stay in the line, addition, and deletion totals), Linked issue (GitHub, Linear or
either), Merge conflicts, CI green, Forbidden paths, Conventional commits
(the title and each of the first 100 commits' first line start
`type(scope)!: `, in any case; merges and reverts skipped), Hidden content
(what cleaning the title, description, commits and paths removed carried
meaning: two or more invisible characters together, tag characters outside
the three subdivision flags, variation selectors that select nothing (not a
lone emoji-style one), bidi overrides or isolates, or a link with no visible
content; on GitHub also hidden markup in the body's markdown, a comment,
reference definition, processing instruction, CDATA section or declaration
not exactly as a pull request template has it (the repository's, else its
organisation's `.github` repository's), that speaks to a model or
holds those characters; it names what it found and where, never the text, and
misses paraphrased, look-alike-letter, entity-encoded or split instructions),
Regression risk (a changed file with four or more commits titled as a fix or revert on the
default branch in the last 30 days, or a migration; labels by default), No duplicate
(an open pull request opened earlier on the same base branch, not a draft, has
the same latest commit, diff or commits, the commits alone where the host gives
no diff to compare; unconfirmed past 100 of them), Sensitive paths (named groups
of globs, high or medium. Its default `onFail` is `ask`, so a high group asks a
maintainer and adds no level label. A level label is written only when `onFail`
is `label`.) and Risk (low,
medium or high from sensitive, size, no-tests, hot-files and first-time; high
asks a maintainer by default, medium labels `risk: medium`). Two always run:
Draft, and Requested changes (a requested change fails and waits on
the author, then on the reviewer once the author pushes or replies). The
recommended forbidden paths are `vendor/**`, `node_modules/**` and
`.github/**`: an author who edits the workflows can change which checks run.

A text rule fails when the title, the description or any commit message (the
first 100) contains one of its phrases, or with `not-contains` when none
does, ignoring case. A `contains` rule also reads the description as written,
with its HTML comments and link addresses; on GitHub, with `hidden-content`
on, not the comments of a pull request template. A policy holds at most eight
rules of its own, text and decision-model together.

### Decision models

Each question has a fixed shape, so the answer is a probability or a choice,
never free text:

- **Is true**: a yes or no claim about the whole pull request, each changed
  file, or each changed hunk, optionally only for paths matching globs.
- **Score**: which of 2 to 10 described levels, worst first, fits a subject.
  It fails only when **fail below** names a level.
- **Choose**: which of the policy's options best describes the pull request;
  it fails when that is one of the failing options.

Built in: **Focused** (each change is classified against the primary change),
**Docs** (each changed file is asked whether it leaves the docs wrong or
incomplete; changing a doc file satisfies the rule) and **Duplicates an open
pull request** (up to five open pull requests opened earlier that share a
changed path, or two title words of four or more letters, are each scored same
change, overlaps or unrelated; one
likely the same change fails it, and it asks a maintainer by default).

An answer decides only when it is clear of a band around a coin flip: 0.7 or
above, or 0.3 or below (0.6 for Focused). Anything inside the band, a missing
answer or a failed model call leaves the rule unconfirmed rather than guessed.
A repository whose rules are all over host data never calls the model.

Focused is skipped on a branch another pull request was merged into, and says
why. A pull request based on another open pull request's branch is checked on
its own changes, and the comment says what it is stacked on.

The model reads the pull request and the repository's docs from its default
branch. Custom rules also get the repository's contribution rules
(`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING`, the pull request template).
[DECISION_MODEL.md](DECISION_MODEL.md) has how questions are asked, budgets,
cost and measured accuracy.

## Verdict

Each pull request head gets one verdict: **Pass**, **Fail** or **Unsure**.

1. A failed rule over host data decides **Fail** without calling the model. So
   does a decision-model rule that fails, so nothing the pull request says can
   talk it into a pass.
2. A policy with no decision-model rule never calls the model: every rule
   passing is **Pass**, and a rule the host has not settled yet, such as
   pending CI, makes it wait (see Waiting for CI).
3. Otherwise one decision-model question decides: does this pull request pass
   this repository's policy? It reads every rule with its result and evidence
   and as much of the pull request as fits one request. **Pass** at 0.7 or
   above for pass, **Fail** at 0.7 or above for fail, **Unsure** otherwise. A
   judged rule left unconfirmed turns a pass into **Unsure**. The score shown
   is the probability of pass. An Unsure comment names each rule Triage could
   not confirm.

A rule's `onFail` changes what its failure does. `ask` makes it Unsure
for a maintainer instead of Fail, unless another rule fails it, and the
verdict question is not asked. `label` rules are left out of all three: they
never decide Fail or Unsure, and the verdict question neither asks about nor
sees them.

Draft pull requests are not decided. A closed or merged one gets no verdict,
and Triage never writes to it. A model that does not answer leaves the verdict Unsure
and Triage checks it again.

Triage keeps one comment on the pull request: the verdict, the reasons, and
what Triage did or what waits on a maintainer. A re-triage edits it in place,
or writes nothing when nothing changed. When only a policy change flips the
verdict on the same head, Triage posts a new comment naming the policy
versions and marks the earlier one superseded.

## Steps

The policy holds one **When** (the events that wake it: `opened`, `updated`,
`checks`, `ready`; all four by default) and three ordered lists of steps:
**On Pass**, **On Fail** and **On Unsure**. The verdict picks the list. Each
step names an action and, optionally, `when` conditions.

- **Actions**: approve, merge, close, comment, request changes, request review
  (from users, teams or code owners), assign, labels, or nothing.
- **Conditions**, which must all hold for the step to run:
  - `author`: any of GitHub's author types (`OWNER`, `MEMBER`,
    `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`,
    `NONE`, `MANNEQUIN`), `BOT` for any bot, the members of a team
    (`{ team }`), or named people (`{ users }`). The groups `maintainers`,
    `external`, `first-timers` and `bots` still read as those types.
  - `linkedIssue`: true or false.
  - `ci`: any of `passing`, `failing`, `pending` or `none`.
  - `files` and `lines`: `{ over: N }`, `{ atMost: N }` or both; lines are
    additions plus deletions.
  - `findings`: with code review on, the open findings the head's review may
    have for the step to run. `{ above: P2 }` allows only findings less severe
    than P2 (P0 is the most severe), `{ any: false }` none and `{ any: true }`
    any. Without it, approve and merge wait until the review has nothing open;
    other actions run whatever it found.

  A step whose conditions do not hold, or whose author the host cannot place,
  is skipped, and the verdict records why. An empty `when` is refused rather
  than read as no condition.

By default, Unsure asks the code owners for review.

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

### Which actions run on their own

An action runs during triage when Triage's own `pr-triage` role holds its
kind on the repository; the rest wait on Triage for a person whose role holds
that kind. The policy file decides what the role holds: by default Triage
takes every action the file names, from a few minutes after triage is turned
on, and stops taking one once it is taken out of the file. With **Take the
actions each policy file names without asking** off in Settings → Triage,
Triage only posts its comment and verdict label on its own, and a policy pull
request from the portal lists the actions that will wait. Turning triage off
for a repository takes back everything Triage did there on its own. Close
never runs on its own on Unsure, and merge never on anything but Pass.

That switch is a brake for the whole workspace. With it off, a repository
earns more one action at a time: **Always approve for this repository** (named
after the held action's kind) lets Triage take that kind of action there on its own from then on.

Approve runs only on a Pass with CI green. A merge waits until CI passes on
the head (or runs without CI only when the policy switches CI green off), and
refuses while anyone has requested changes; Triage's own request for changes
is taken back first. A merge also waits while a person's review thread on the
pull request is unresolved, and while Triage cannot read the threads. Threads
on Triage's own code review findings do not count; code review's own rule
covers them. Resolving the last thread lets the merge go ahead and releases
no other action. Branch protection stays the
backstop. Request changes lists the failed rules, once per head, and is
dismissed once none still fails.

### In progress

Where Triage comments on its own, a pull request has one Triage comment. While
the verdict waits for CI, the decision model or code review, that comment
reads **Triage: In progress** and names what it waits for, such as "Triage is
waiting for the decision model's answer and code review before it decides".
It is rewritten when what it waits for changes, and the verdict replaces it in
place. If the decision model or code review keep Triage waiting three hours
after it started on the pull request, it gives the verdict anyway, says what it
stopped waiting for, and runs no action on its own.

### Waiting for CI

Triage checks a new head at once. When a rule the host has still to settle is
unconfirmed (CI still running, mergeability not computed yet), whatever else
it could not confirm, or CI still runs and a step reads it (a CI condition,
approve or merge), the head gets no verdict yet: Triage shows **Waiting for CI**, runs no action, and
decides once they are done, as soon as a check fails, or after an
hour at most. When CI green is on, a head with no checks within 2 minutes of
Triage first seeing it is taken as having no CI. Triage again,
and a head's last retry, decide at once. On GitHub a
pull request labelled `Triage: Not Ready` or `Triage: Needs Human Review`
keeps it, so a push that leaves the verdict as it was changes no label; any
other shows `Triage: Waiting for CI` until the verdict replaces it, or no
Triage label while the head has no checks. On Bitbucket the head's `Corbits
Triage` build status is in progress until its verdict. A head decided while CI
still runs, on Triage again or its last retry, has every action that reads CI
held.

### Labels

Labels are the handoff: other tools, such as a coding agent, watch for them.
Their names are stable:

| Label | When |
| --- | --- |
| `Triage: Ready` | The head passes. Taken off as soon as Triage sees a new head, until that head passes. |
| `Triage: Not Ready` | The head fails. |
| `Triage: Needs Human Review` | The head is unsure. |
| `Triage: Waiting for CI` | Triage is waiting for the head's CI before it decides, unless the pull request is Not Ready or Needs Human Review or the head has no checks. |
| `Triage: Failed to Run` | Triage could not read the pull request; the next verdict replaces it. |
| `rule: <rule id>` | A rule that failed on the head, such as `rule: docs`, from a `{ do: labels, target: { from: rules } }` step. |

A head carries one verdict label at a time, and Triage takes back the ones
that no longer apply, including the retired `Triage: Needs changes`,
`Triage: Needs review`, `Triage: Ready to merge` and `triage:…` labels. A policy may rename any verdict's label (up to 50
characters) under `labels`, for example `labels: { pass: Ready to ship }`.
Bitbucket Data Center has no labels; the `Corbits Triage` build status carries
the verdict there.

## Policy file

A repository's policy is `.corbits-triage.yml` at the root of its default
branch (`.corbits-triage.yaml` when there is no `.yml`), so policy changes are
reviewed like code. It lists `rules`, `actions` and `labels`, and may
`extends` another repository's policy file. It may also
hold the v4 keys `groups`, `code-review`, `pauseLabel` and `decide`. Any other key is refused, naming
the key it was likely meant to be. A step's `when.author` may name a group.
On GitHub, a pull request carrying `pauseLabel` starts no run, and while the
pull request cannot be read it is not triaged but retried, never run unpaused;
through a long GitHub outage it waits out a bounded number of retries and is
triaged on its next event. Code review runs on Anthropic with the workspace's Anthropic key: `provider` must be `anthropic`,
the only reviewer in this release, and the optional `profile` is checked but does not affect the review yet; a file naming any
other provider, or holding `pace`, is refused, since pacing is not available. `decide` is read and
checked, and nothing acts on it. A file holds `decide` or `actions`, never
both, so a file that sets `decide` takes no actions. With `code-review` on, an
action runs once the head's review meets its step's `when.findings`, and
approve and merge without one run only when the review has no findings open. A
file that uses `extends` holds none of these keys.

Each rule is one sentence (`text`), how it is checked (`check`: a built-in
rule's id, `model` for a yes/no question about the whole pull request, or
`text` for a phrase match) and why it exists: a one-line `reason` and its
`evidence` (`#44`, `owner/name#44`, links or `maintainer-stated`). All four
are required. A model, text or code-patterns rule names its own `id`. A built-in rule takes
its setting as `max` (size limits), `tracker` (linked issue), `paths`
(forbidden paths) or `types` and `fields` (conventional commits). A
code-patterns rule lists shipped `presets` (`convention`) and its own ast-grep
`patterns`, and fails on a match in a line the pull request adds to a
TypeScript or JavaScript file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, `.cjs`); it checks nothing in other languages. Its own pattern wins on
a shared id in both languages; to keep checking JavaScript, add a
`language: javascript` pattern under the same id. A pattern's ast-grep `files`
and `ignores` lists scope it to paths by ast-grep's glob rules (strings only;
a negated class is `[^a]`, and `[!a]` or an invalid glob refuses the policy),
and the preset's fallback patterns ignore test files. `enabled: false` keeps it
written down but off.
`onFail` says what a failing rule does: `fail` (the default, except `label`
for the size rules and regression risk, and `ask` for sensitive paths, risk
and the judged duplicate rule) fails the pull
request for its author, `ask` makes it Unsure and lists the rule for a
maintainer instead of the author, and `label` makes the rule label the pull
request instead of deciding its verdict. A top-level `onFail` is the default
for the file's rules. With `label`, when the rule fails or stays unsure, the
verdict is unchanged, the comment notes it, and an Add labels action adds its label (`size: large`,
`docs: check`, `<id>: check`, or the rule's own `label`). The label follows
the rule: the same action takes it back once the rule passes, and takes back
a level label of sensitive paths or risk when the level changes. A label a
person added that the policy does not name for a rule is never taken back. A label a `labels` step in the policy also names is left alone. A label starting `Triage:` or `rule: `, a verdict label, or a level label of
sensitive paths or risk other than the rule's own is refused, and so is a level
label in a `labels` step. On Bitbucket Data Center it is only noted.

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
    phrases: ["Co-Authored-By:", "Generated with"]
    reason: Maintainer-stated.
    evidence: [maintainer-stated]
  - id: conventions
    check: code-patterns
    text: Added code follows our conventions.
    presets: [convention]
    patterns: # ast-grep rules; `rule` is an ast-grep rule object
      - id: no-console
        language: typescript # or javascript
        message: Remove console logging.
        ignores: ["scripts/**"] # ast-grep globs; `files` checks only the paths it names
        rule: { pattern: "console.log($$$ARGS)" }
    onFail: label
    reason: Review time goes to design, not style.
    evidence: [maintainer-stated]
```

Only YAML is read, up to 64 KB and without anchors or aliases. Names, claims,
labels and the like are one line of at most 500 characters (50 for a label);
a comment keeps its line breaks. A list of labels, people or teams holds at
most 50, and a verdict at most 20 steps. The JSON Schema is `policyFile` at the hub's
`/api/integrations/pack-schema`, and `POST /api/integrations/policy/validate`
checks a file's text without signing in. The GitHub Action in
[packages/policy-check-action](../packages/policy-check-action/action.yml)
checks the file the same way on pull requests, and runs the base branch policy's
rules that need no model, except ci-green, against each one.

A push to the default branch that changes the file is read before the next
verdict. A file Triage refuses stops triage on the repository until it is
fixed; the portal shows each problem with its line. Score and choose rules and
file or hunk scope are written in the stored-policy shape (`custom`), which a
file without `rules` or a v4 key is read in; see
[@corbits/triage-contracts](../packages/triage-contracts/README.md).

The file is the only policy: a repository without it runs no triage and offers
**Start a policy file**, a pull request adding the starter rules (at most 30
files and 3,000 lines changed, no merge conflicts, CI green, sensitive paths
and risk; no actions). The portal edits the file in place and saves it as a
pull request, or pushes it straight to the default branch where the branch's
rules let Triage push, cautioning first when the edit lets Triage approve or
merge risky changes on its own;
[the manual](Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#editing-the-file)
walks through it.

### Shared policies

`extends: owner/name` (`PROJECT/slug` on Bitbucket) starts from that
repository's policy file on its default branch. It is a default, not a floor:
the extending file may switch off or replace any of its rules, its When, any
verdict's steps and any verdict's label. The repository must be connected to the
same workspace and its file must not extend another; otherwise triage refuses
the file and says why. A push or merge to that file reaches every repository
extending it from their next verdict. The pull request check validates the file
itself, not the policy it extends.

## Code review

Code review reads a pull request for defects: correctness bugs in the changed
lines and breakage the change causes elsewhere in the repository. Each defect
names the line, why it is wrong, what triggers it and a fix, most severe and
most agreed-on first. It is separate from the verdict and optional.

A repository's policy file turns it on with its `code-review` block, which
also says whose pull requests (`for`) and which verdicts and paths (`when`) it
reviews. It needs an Anthropic key saved under Settings → Code review, and each
reviewed commit is billed to that Anthropic account. A commit is reviewed once
the rules that fail a pull request without the decision model have passed, or
whatever they say with `when: { rules: any }`; drafts are not reviewed.
**Review again** reviews the current commit once more, whatever the file says.
The review receives patches directly in bundles; completion means every
assigned bundle returned its review work, not proof that every line was read.
A missing or failed bundle leaves the review unfinished and holds approve and
merge. Exhausting the review budget is tracked separately and also holds
approve and merge, even when all bundles returned. Older incomplete review
records remain incomplete and continue to hold approve and merge.
A review sandbox that never connects is replaced, up to three in all. If the review still cannot start, or
its run dies, Triage gives the verdict without it, says the review failed, and
holds approve and merge.

Each review checks out the pull request's code, so it runs in an isolated
place of its own; while the server has none, the repository page links
Settings → Code review, which lists the places this server knows and how to
set each up ([provisioners](provisioners/README.md)).
Findings show in the reading pane, and Triage posts the review with its
verdict: on GitHub as one review from the Triage App, inline where the diff
shows the lines; on Bitbucket Data Center as a comment per finding the diff
shows, on its first shown line, and one summary comment with the rest. A
finished review that is not on the pull request yet is posted with **Send to
GitHub** or **Send to Bitbucket**, once per commit. Sending needs only a
finished review, so it works without an isolated place.

## Triage over time

Turning triage on triages a GitHub repository's open pull requests; after
that, events are triaged as they arrive, and the hub re-queues any open pull
request whose latest commit has no verdict. A pull request merged into the
default branch makes the repository's other open pull requests due again, each
at most once per 15 minutes. A re-check of a commit whose verdict nothing on
the host can still change posts that verdict again without asking the decision
model; a new commit is judged afresh.

## Limits

- The hub does not run the repository scan, which measures closed pull requests.
- The Railway Sandboxes provisioner uses the operator's Railway token only;
  a workspace cannot bring its own.
