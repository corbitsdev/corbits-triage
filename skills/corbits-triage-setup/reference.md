# .corbits-triage.yml reference

The file holds `rules` (required), and optionally `actions` or `decide`, `labels`, `extends`, `groups`, the blocks `code-review`, `security` and `deslop`, `pace` and `pauseLabel`. Any other key is refused, with the key it was likely meant to be. Every refusal names its line and what the value must be. YAML only, at most 64 KB; YAML aliases (`*name`) and the keys `__proto__`, `constructor` and `prototype` are refused. Triage reads `.corbits-triage.yml` and ignores `.corbits-triage.yaml` when both exist, so keep one.

## Rules

Every rule has:

- `check`: a built-in rule's id, `model` or `text`.
- `text`: one sentence saying what the rule asks (at most 500 characters).
- `reason`: one line on why the rule exists.
- `evidence`: a list of `maintainer-stated`, pull request references (`"#44"`, `"owner/name#44"`) or `https://` links. Quote `#` references.
- `enabled: false` (optional) keeps a rule written down but off.
- `onFail` (optional) is what a failing rule does: `fail` (the default) fails the pull request for its author, `ask` makes it Unsure and leaves it to a maintainer, and `label` makes the rule label the pull request instead of deciding its verdict. A top-level `onFail` sets the default for every rule in the file. With `label`, when it fails, or the model can't tell, the verdict is unchanged; Triage adds its label and a line under **Notes:** in its comment, and never takes the label off. The label is `size: large` for the size rules, `docs: check` for `docs` and `<id>: check` otherwise; `label:` (at most 50 characters) names another. `label` without `onFail: label` is refused, and so is one starting `Triage:` or `rule: ` or naming a verdict label.

A built-in rule is named only by `check`, never `id`, and each built-in may appear once. A `model` or `text` rule also needs its own `id`.

### Built-in rules

| `check` | Setting | Needs a model | What it does |
| --- | --- | --- | --- |
| `max-files-changed` | `max:` whole number ≥ 1 (required) | no | Fails over `max` files changed. |
| `max-lines-changed` | `max:` whole number ≥ 1 (required) | no | Fails over `max` lines changed. |
| `no-merge-conflicts` | none | no | Fails when the pull request conflicts with its base. |
| `ci-green` | none | no | Fails when checks fail; unconfirmed while they run; passes when there are no checks. |
| `linked-issue` | `tracker:` `github`, `linear` or `either` (optional, default `either`) | no | Fails unless the title, description, a commit or the branch name references an issue. `github` reads `#123`, GitHub issue links and branches like `123-title`; `linear` reads any key like `ABC-123` (so Jira keys match too), Linear links and branches like `abc-123-title` in any case. |
| `no-forbidden-paths` | `paths:` list of 1–50 globs (required) | no | Fails when any changed file matches; for every author, maintainers too. `*` stays within a folder, `**` crosses folders. |
| `conventional-commits` | `types:` list of words (optional, default `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `build`, `style`, `revert`); `fields:` `title`, `commits` or both (optional, default both) | no | Fails unless the title and each commit's first line (first 100 commits) start `type: `, `type(scope): ` or `type!: ` with a listed type, in any case. Merges and `Revert "…"` commits are skipped. |
| `hidden-content` | none | no | Fails when the title, description, a commit message or a changed path hides text: two or more invisible characters together, Unicode tag characters other than the England, Scotland and Wales flags, variation selectors that change nothing shown (a lone emoji-style one is allowed), bidi overrides or isolates (not the embeddings and marks RTL text uses), or a link with no visible content. On GitHub it also fails when a comment, `[//]: #` definition or other hidden markup the author added to the description speaks to a model, such as "ignore previous instructions", or holds those characters; a comment exactly as the repository's pull request templates (or, with none, its organisation's `.github` repository's) have it is skipped. Bitbucket Data Center checks the characters only. Names what it found and where, never the text. Misses paraphrased, look-alike-letter, entity-encoded or split instructions. |
| `focused` | none | yes | The decision model checks the change is focused on one thing. |
| `docs` | none | yes | The decision model checks docs are updated when behaviour changes. |

### Rules of your own

At most 8 in total. `id` is lowercase letters, digits and single hyphens, at most 64 characters; it must not be a built-in id, start with `docs-` or `focused-`, or end in `-file`, `-hunk` or `-slice` followed by numbers.

- `check: model` (needs a model): `text` is a statement the decision model answers yes or no about the whole pull request; the rule fails on no. Example `text`: `The title says what changed.`
- `check: text` (no model): fails on a phrase match, case ignored. A phrase matches anywhere in the field; there is no prefix or pattern match.
  - `fields`: any of `title`, `description`, `commits` (each commit message; first 100 commits).
  - `failWhen`: `contains` (fail when any field has any phrase) or `not-contains` (fail when a field has none of them).
  - `phrases`: 1–50 strings.

A model rule costs one model request per pull request and needs a decision model set up in Corbits Triage (Settings → Models). Rules without a model always give the same answer for the same pull request and cost nothing.

### When to add

Start from the four starter rules (SKILL.md step 3). Add an extra only when the repository shows a reason:

| Signal | Extra rule |
| --- | --- |
| Issue links or `ABC-123` keys in most commits or branches (not squash-merge `(#123)` suffixes) | `linked-issue`: `github` for `#123`, `linear` for `ABC-123` keys from any tracker, `either` for both |
| Vendored or generated folders that pull requests should never touch | `no-forbidden-paths` listing them |
| Commits mostly follow conventional commits | `conventional-commits`; add `types` only when the history uses a type outside the default list, and `fields: [title]` when pull requests are squash-merged |
| The user wants to hear when a pull request hides text from reviewers | `hidden-content` with `onFail: ask` |
| The user bars tool attribution | `no-tool-attribution` below. Add the user's tool trailers to its phrases; never a bare `Co-Authored-By:`, which also fails human co-authors. |
| A decision model is set up and pull requests often mix changes | `focused` |
| A decision model is set up and the repository keeps user docs beside its code | `docs` |

`no-forbidden-paths` fails maintainers too, so never list `.github/**` or another path the team edits on purpose unless the user asks.

When the user wants a rule to flag pull requests without failing them, such as size limits that atomic changes cross or a docs reminder, add `onFail: label` to it. When they want a person to decide instead of the author fixing it, use `onFail: ask`.

## Actions

Optional. Without `actions`, Triage only sets its verdict label. Each verdict has an ordered list of at most 20 steps; a verdict left out has none.

```yaml
actions:
  on: [opened, updated, checks, ready]   # optional; this is the default
  unsure:
    - do: request-review
      target: { to: codeowners }
```

`on` takes any of `opened`, `updated`, `checks`, `ready`.

| `do` | `target` |
| --- | --- |
| `approve`, `merge`, `close`, `request-changes`, `nothing` | none |
| `comment` | `{ body: "text" }` |
| `labels` | `{ from: list, labels: [name, …] }` or `{ from: rules }` (one `rule: <id>` label per failed rule) |
| `request-review` | `{ to: codeowners }`, `{ to: users, users: [login, …] }` or `{ to: teams, teams: [org/team, …] }` |
| `assign` | as `request-review`, or `{ to: author }` |

A step may add `when`, and every condition in it must hold. An empty `when` is refused.

- `author`: list of `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`, `BOT`, the groups `maintainers`, `external`, `first-timers`, `bots`, `{ team: org/team }` or `{ users: [login, …] }`.
- `linkedIssue`: `true` or `false`.
- `ci`: list of `passing`, `failing`, `pending`, `none`.
- `files` / `lines`: `{ over: N, atMost: M }`, either or both, `atMost` more than `over`.

Never write `for:` on a step; who it is for goes in `when.author`.

Triage carries out an action on its own only where the workspace allows that action for the repository (repository page, Actions Triage takes on its own); otherwise it waits for a person in the Inbox. Merge on Fail or Unsure, and Close on Unsure, always wait for a person, whatever the workspace allows. An advisory rule's label is added the same way, as an Add labels action. On Bitbucket Data Center, `labels` and `assign` have no effect (an advisory rule only adds its note), `request-review` to `teams` can't be carried out (it has no team reviewers), and `codeowners` means the pull request's default reviewers.

## Labels

Optional. Renames the verdict labels (at most 50 characters each). Defaults:

```yaml
labels:
  pass: "Triage: Ready"
  fail: "Triage: Not Ready"
  unsure: "Triage: Needs Human Review"
```

## Blocks and decide

Triage checks these keys but does not act on them yet; write them only when the user asks. A file holds `decide` or `actions`, never both.

```yaml
groups:
  maintainers: { association: [OWNER, MEMBER, COLLABORATOR] }
code-review: { on: true, for: [maintainers], provider: anthropic }
security:
  on: true
  when: { triage: pass, paths: ["src/**"] }
  clean: { below: medium }
deslop: { on: false }
pace: { debounce: 30s, maxWait: 2m, perHead: 1, cap: { runs: 5, per: 24h }, backoff: { pushes: 5, within: 10m, pause: 30m } }
pauseLabel: "corbits: pause"
decide:
  - { if: { triage: fail }, do: [request-changes, { do: comment, target: { body: "Please fix the failed rules." } }] }
  - { if: { all: clean }, do: approve }
  - { if: { code-review: findings }, do: review }
```

- `groups`: each named in lowercase words joined by hyphens, starting with a letter, at most 64 characters, with any of `association` (the author kinds under Actions), `teams` (`org/team`) and `users` (logins). The first group an author matches, in the order written, is theirs; they are in at most one. The built-in groups `maintainers`, `external`, `first-timers` and `bots` exist without being defined and match by author kind alongside it; defining one with that name replaces it. `everyone` is built in and always matches. A group or `everyone` can be named in `for`, `if.author` and a step's `when.author`. A built-in group is author kinds, so it still matches when teams can't be read, and is not known only when the author kind is. Whether the author is in a group the file defines is not known when the author kind is unknown, or when teams Triage can't read would decide which defined group is theirs. A step for a group that is not known doesn't run; `everyone` always matches. Never let `approve` or `merge` rest on `everyone` alone.
- A block (`code-review`, `security`, `deslop`) takes only:
  - `on`: `true` or `false` (required).
  - `for`: list of groups; default everyone.
  - `when`: `triage` (`pass`, `fail`, `unsure` or a list of them) and `paths` (globs; any changed file matching is enough).
  - `clean`: `below` (`low`, `medium`, `high` or `critical`), `minConfidence` (0 to 1), `coverage: full`.
  - `provider`: `anthropic`, `openai`, `xai`, `google`, `opencode` or `custom`. Every block that is on and names one must name the same.
- `pace`: `debounce`, `maxWait` (durations of at least 1, such as `30s`, `2m`, `24h`, `7d`), `perHead` (whole number ≥ 1), `cap: { runs, per }`, `backoff: { pushes, within, pause }`.
- `pauseLabel`: a label of at most 50 characters.
- `decide`: rules `{ if, do }`, in order. `if` sets at least one of `all: clean`, `triage`, `event` (a list of `opened`, `updated`, `checks`, `ready`), `author` (groups) and the outcome of a block that is on (`clean`, `findings`, `incomplete`, `skipped`, a list of them, or `{ findings: <severity> }`). `do` is `approve`, `merge`, `close`, `request-changes`, `review`, `nothing`, or a list of those and steps written as under Actions (`comment`, `labels`, `request-review` and `assign` need their `target`). `nothing` stands alone. `{ all: clean }` holds when every block that actually ran is clean, and holds with none on; skipped blocks never count. Incomplete is never clean: a rule that approves or merges can't name `incomplete`, and only matches when nothing that ran is incomplete.

A file with `actions` reads as `decide`: each verdict's steps become one rule on `triage: <verdict>` (and `event: <actions.on>` when `on` lists fewer than every event), a Pass or Fail with none becomes `do: nothing`, and an Unsure with none becomes no rule. A file that uses `extends` can't hold `groups`, blocks, `pace`, `pauseLabel` or `decide`.

## extends

`extends: owner/name` starts from that repository's `.corbits-triage.yml` and sets only what differs; `extends: <id>` does the same from a workspace policy. Use it only when the user names the repository or gives the id. The repository must be connected to the same workspace and its own file must not use `extends`. The local check can't see either, so "valid" does not prove it can be read; tell the user to confirm it.

## Starter file

```yaml
# Corbits Triage policy.
rules:
  - check: max-files-changed
    text: Flag pull requests over 30 files changed.
    max: 30
    reason: Large pull requests are hard to review.
    evidence: [maintainer-stated]
  - check: max-lines-changed
    text: Flag pull requests over 3,000 lines changed.
    max: 3000
    reason: Large pull requests are hard to review.
    evidence: [maintainer-stated]
  - check: no-merge-conflicts
    text: Flag merge conflicts with the base branch.
    reason: A pull request with conflicts can't be merged as it is.
    evidence: [maintainer-stated]
  - check: ci-green
    text: CI must pass before merge.
    reason: A change is not ready until CI passes.
    evidence: [maintainer-stated]
```

## Extras, written out

```yaml
  - check: linked-issue
    text: Require a linked issue from GitHub.
    tracker: github
    reason: Every change is tracked in an issue.
    evidence: [maintainer-stated]
  - check: no-forbidden-paths
    text: Never accept changes to vendor/**.
    paths: ["vendor/**"]
    reason: Generated or vendored code is changed by its own process.
    evidence: [maintainer-stated]
  - check: conventional-commits
    text: Require a conventional commit title and messages.
    reason: The repository's commits follow conventional commits.
    evidence: [maintainer-stated]
  - id: no-tool-attribution
    check: text
    text: Descriptions and commits carry no tool attribution.
    fields: [description, commits]
    failWhen: contains
    phrases: ["Generated with"]
    reason: Tool-generated trailers don't belong in descriptions or commits.
    evidence: [maintainer-stated]
  - id: title-says-what-changed
    check: model
    text: The title says what changed.
    reason: Reviewers pick pull requests from their titles.
    evidence: [maintainer-stated]
```

## Pull request check (GitHub)

`.github/workflows/corbits-triage-policy.yml`:

```yaml
name: Corbits Triage policy
on:
  pull_request:
    paths: [".corbits-triage.yml", ".corbits-triage.yaml"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: corbitsdev/corbits-triage/packages/policy-check-action@main
```
