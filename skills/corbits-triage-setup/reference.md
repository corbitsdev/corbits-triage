# .corbits-triage.yml reference

The file holds `rules` (required), and optionally `actions`, `labels` and `extends`. Any other key is refused. YAML only, at most 64 KB; YAML aliases (`*name`) are refused. Triage reads `.corbits-triage.yml` and ignores `.corbits-triage.yaml` when both exist, so keep one.

## Rules

Every rule has:

- `check`: a built-in rule's id, `model` or `text`.
- `text`: one sentence saying what the rule asks (at most 500 characters).
- `reason`: one line on why the rule exists.
- `evidence`: a list of `maintainer-stated`, pull request references (`"#44"`, `"owner/name#44"`) or `https://` links. Quote `#` references.
- `enabled: false` (optional) keeps a rule written down but off.

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
| Commits mostly follow conventional commits | `conventional-title` below. Copy its phrases exactly and add `type:`, `type(`, `type!:` for each other type in the history (at most 5 more; 50 phrases in all). It checks the title contains a type, not that it starts with one. |
| The user bars tool attribution | `no-tool-attribution` below. Add the user's tool trailers to its phrases; never a bare `Co-Authored-By:`, which also fails human co-authors. |
| A decision model is set up and pull requests often mix changes | `focused` |
| A decision model is set up and the repository keeps user docs beside its code | `docs` |

`no-forbidden-paths` fails maintainers too, so never list `.github/**` or another path the team edits on purpose unless the user asks.

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

Triage carries out an action on its own only where the workspace allows that action for the repository (repository page, Actions Triage takes on its own); otherwise it waits for a person in the Inbox. Merge on Fail or Unsure, and Close on Unsure, always wait for a person, whatever the workspace allows. On Bitbucket Data Center, `labels` and `assign` have no effect, `request-review` to `teams` can't be carried out (it has no team reviewers), and `codeowners` means the pull request's default reviewers.

## Labels

Optional. Renames the verdict labels (at most 50 characters each). Defaults:

```yaml
labels:
  pass: "Triage: Ready"
  fail: "Triage: Not Ready"
  unsure: "Triage: Needs Human Review"
```

## extends

`extends: <id>` starts from a workspace policy and sets only what differs. Use it only when the user gives the workspace policy's id. The local check can't see the workspace, so "valid" does not prove the id exists; tell the user to confirm it.

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
  - id: conventional-title
    check: text
    text: The title contains a conventional commit type such as feat or fix.
    fields: [title]
    failWhen: not-contains
    phrases:
      - "feat:"
      - "feat("
      - "feat!:"
      - "fix:"
      - "fix("
      - "fix!:"
      - "docs:"
      - "docs("
      - "docs!:"
      - "style:"
      - "style("
      - "style!:"
      - "refactor:"
      - "refactor("
      - "refactor!:"
      - "perf:"
      - "perf("
      - "perf!:"
      - "test:"
      - "test("
      - "test!:"
      - "build:"
      - "build("
      - "build!:"
      - "ci:"
      - "ci("
      - "ci!:"
      - "chore:"
      - "chore("
      - "chore!:"
      - "revert:"
      - "revert("
      - "revert!:"
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
