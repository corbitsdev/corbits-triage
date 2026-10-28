# .corbits-triage.yml reference

The file holds `rules` (required), and optionally `onFail`, `actions` or `decide`, `labels`, `extends`, `groups`, the block `code-review`, `pace` and `pauseLabel`. Any other key is refused, with the key it was likely meant to be. Never write `security` or `deslop`: those reviews are not available. In a file already on the default branch, Triage skips either block and any `decide` rule with a condition on one, runs the rest, and offers a pull request removing them; Triage refuses a file written with them. Every refusal names its line and what the value must be. YAML only, at most 64 KB; YAML aliases (`*name`) and the keys `__proto__`, `constructor` and `prototype` are refused.

## Rules

Every rule has:

- `check`: a built-in rule's id, `model`, `text` or `code-patterns`.
- `text`: one sentence saying what the rule asks (at most 500 characters).
- `reason`: one line on why the rule exists.
- `evidence`: a list of `maintainer-stated`, pull request references (`"#44"`, `"owner/name#44"`) or `https://` links. Quote `#` references.
- `enabled: false` (optional) keeps a rule written down but off.
- `onFail` (optional) is what a failing rule does: `fail` (the default, except `label` for the size rules) fails the pull request for its author, `ask` makes it Unsure and leaves it to a maintainer, and `label` makes the rule label the pull request instead of deciding its verdict. A top-level `onFail` sets the default for every rule in the file. With `label`, when it fails, or the model can't tell, the verdict is unchanged; Triage adds its label and a line under **Notes:** in its comment, and takes the label off once the rule passes. A label a `labels` step in the policy also names is left alone. The label is `size: large` for the size rules, `docs: check` for `docs` and `<id>: check` otherwise; `label:` (at most 50 characters) names another. `label` without `onFail: label` is refused, and so is one starting `Triage:` or `rule: `, naming a verdict label, or naming a level label of sensitive paths or risk (`sensitive: medium`, `risk: high`) other than the rule's own.

The five `max-` rules are the size rules. Lockfiles are left out of their counts (on Bitbucket Data Center, out of the file count only).

A built-in rule is named only by `check`, never `id`, and each built-in may appear once. A rule of your own also needs its own `id`.

### Built-in rules

| `check` | Setting | Needs a model | What it does |
| --- | --- | --- | --- |
| `max-files-changed` | `max:` whole number ≥ 1 (required) | no | Fails over `max` files changed. |
| `max-lines-changed` | `max:` whole number ≥ 1 (required) | no | Fails over `max` lines changed. |
| `max-lines-changed-per-file` | `max:` whole number ≥ 1 (required) | no | Fails when any one file has over `max` lines changed. Always passes on Bitbucket Data Center, which reports no lines per file. |
| `max-additions` | `max:` whole number ≥ 1 (required) | no | Fails over `max` lines added. |
| `max-deletions` | `max:` whole number ≥ 1 (required) | no | Fails over `max` lines deleted. |
| `no-merge-conflicts` | none | no | Fails when the pull request conflicts with its base. |
| `ci-green` | none | no | Fails when checks fail; unconfirmed while they run or when one was cancelled or went stale; a skipped check passes; passes when there are no checks. Only the newest run of each check counts. |
| `linked-issue` | `tracker:` `github`, `linear` or `either` (optional, default `either`); `off` is refused in the file, so leave the rule out or set `enabled: false` instead | no | Fails unless the title, description, a commit or the branch name references an issue. `github` reads `#123`, GitHub issue links and branches like `123-title`; `linear` reads any key like `ABC-123` (so Jira keys match too), Linear links and branches like `abc-123-title` in any case. |
| `no-forbidden-paths` | `paths:` list of 1–50 globs (required) | no | Fails when any changed file matches; for every author, maintainers too. `*` stays within a folder, `**` crosses folders, and `**/` also matches no folder. |
| `conventional-commits` | `types:` list of words (optional, default `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `build`, `style`, `revert`); `fields:` `title`, `commits` or both (optional, default both) | no | Fails unless the title and each commit's first line (first 100 commits) start `type: `, `type(scope): ` or `type!: ` with a listed type, in any case. Merges and `Revert "…"` commits are skipped. |
| `hidden-content` | none | no | Fails when the title, description, a commit message or a changed path hides text: invisible, tag or bidi override characters, or a link with no visible content. On GitHub, also hidden markup in the description that speaks to a model, other than the repository's pull request template. |
| `regression-risk` | `hotFileFixes:` whole number ≥ 1 (optional, default 4); `migrations:` list of 1–50 globs (optional, default `**/migrations/**`, `**/*.sql`) | no | Fails when a changed file (not a test, Markdown doc or lockfile) has at least `hotFileFixes` commits in the last 30 days whose subject starts with a `fix`, `bugfix`, `hotfix` or `revert` type (`fix:`, `fix(scope):`, `Revert "…"`); merges and body text don't count. Also fails when a changed file matches `migrations`. A history that can't be read in full, or a pull request changing more than 300 such files, leaves the rule unconfirmed. Default `onFail` is `label`. |
| `sensitive-paths` | `groups:` map of group name (lowercase words joined by hyphens) to `{ level: high or medium, paths: list of 1–50 globs }` (optional, default `schema`, `auth` high; `ci`, `locks` medium); `failAt:`, `labelAt:` `medium` or `high` (optional, default `high` and `medium`) | no | Fails when a changed file matches a group at `failAt` or above, globs as in `no-forbidden-paths`; below that, from `labelAt`, passes and labels `sensitive: <level>`. Evidence names each group with up to five files. Defaults: `schema` `**/migrations/**`, `**/*.sql`; `auth` `**/auth/**`, `**/secrets/**`; `ci` `.github/**`, `**/Dockerfile`, `**/railway.json`, `**/railway.toml`; `locks` `**/bun.lock`, `**/package-lock.json`, `**/yarn.lock`, `**/pnpm-lock.yaml`; writing `groups` replaces all four, so list each one to keep. Default `onFail` is `ask`. |
| `risk` | `medium:`, `high:` a number of signals from 1 to 5, or a list of signals where a nested list needs all of its own (optional, default `1` and `[[size, no-tests]]`); `failAt:`, `labelAt:` `medium` or `high` (optional, default `high` and `medium`) | no | Rates the pull request low, medium or high from five signals: `sensitive` (a medium `sensitive-paths` group, default groups if unset; a high group makes it high on its own unless `sensitive-paths` is on), `size` (over the `max-files-changed` or `max-lines-changed` limit, default 30 and 3,000), `no-tests` (source code in a common language changed, not `*.d.ts`, `docs/` or `examples/`, and no test file, `e2e/`, `cypress/` or `__snapshots__/` file), `hot-files` (a file `regression-risk` counts as hot) and `first-time` (a first-time contributor; never on Bitbucket Data Center). Fails at `failAt`; below it, from `labelAt`, passes and labels `risk: <level>`. Unconfirmed when unread history could make a file hot and the rule fail. Default `onFail` is `ask`. |
| `no-duplicate` | none | no | Fails when an earlier open pull request on the same base branch, drafts left out, has the same diff or the same commits, and names it. |
| `duplicates-open-pull-request` | none | yes | The decision model checks the change is not already made by another open pull request on the same base branch that shares a changed path or title words with it. Default `onFail` is `ask`. |
| `focused` | none | yes | The decision model checks the change is focused on one thing. |
| `docs` | none | yes | The decision model checks docs are updated when behaviour changes. |

### Rules of your own

At most 8 in total. `id` is lowercase letters, digits and single hyphens, at most 64 characters; it must not be a rule id Triage uses (the check names a clash), start with `docs-`, `focused-` or `duplicates-open-pull-request-`, or end in `-file`, `-hunk` or `-slice` followed by numbers.

- `check: model` (needs a model): `text` is a statement the decision model answers yes or no about the whole pull request; the rule fails on no. Example `text`: `The title says what changed.`
- `check: text` (no model): fails on a phrase match, case ignored. A phrase matches anywhere in the field; there is no prefix or pattern match. A `contains` rule on `description` also reads the description's hidden parts (HTML comments and link addresses); `not-contains` reads only what a reader sees.
  - `fields`: any of `title`, `description`, `commits` (each commit message; first 100 commits).
  - `failWhen`: `contains` (fail when any field has any phrase) or `not-contains` (fail when a field has none of them).
  - `phrases`: 1–50 strings.
- `check: code-patterns` (no model): fails when a line the pull request adds to a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs` file matches (no other language is checked, so leave it out of a repository with none); vendored and built files are skipped. On Bitbucket Data Center, which sends no patches, it is unconfirmed whenever a TypeScript or JavaScript file of your own is added, edited, moved or copied. A pull request adding code to more than 300 such files leaves it unconfirmed.
  - `presets: [convention]` (TypeScript and JavaScript): invented `?? 0`/`?? []` fallbacks outside tests, nested ternaries, immediately invoked functions, `.then`/`.catch`/`.finally` chains, empty `catch` blocks, suppression comments.
  - `patterns`: ast-grep rules with `id`, `language` (`typescript` or `javascript`), `message`, `rule` (an ast-grep rule object), and optional `files` (only these paths) and `ignores` (not these). Globs are strings from the repository root, by ast-grep's rules: `*` crosses folders; write `[^a]`, never `[!a]`. Patterns may share an `id` across languages. A pattern replaces a preset's with the same `id` in both languages; to keep checking JavaScript, add a `language: javascript` pattern under the same id.

A model rule, like the built-in `focused`, `docs` and `duplicates-open-pull-request`, costs model requests on every pull request and needs a decision model set up in Corbits Triage (Settings → Triage → Decision model).

### When to add

The starter file is the baseline. Each extra fits when the repository shows its signal; SKILL.md step 1 measures most of them:

| Signal | Extra rule |
| --- | --- |
| Most merged pull requests link an issue with a closing keyword (`Closes #12`), an issue link or a key like `ABC-123` | `linked-issue`, with `tracker` set to the kind they use: `github`, `linear`, or `either` for both |
| Most pull request titles follow conventional commits | `conventional-commits`; about half suggests `onFail: label` or leaving it out |
| Vendored or generated folders that are checked in and that no merged pull request changed, and a person confirms | `no-forbidden-paths` listing them; when pull requests do change them, a `sensitive-paths` group instead |
| The history uses a commit type outside the default list | `types` on `conventional-commits`, listing the whole default list plus each extra type the history uses, since `types` replaces the default list |
| Pull requests are squash-merged, or their titles are conventional but most commits are not | `fields: [title]` on `conventional-commits` |
| The user wants to hear when a pull request hides text from reviewers | `hidden-content` with `onFail: ask` |
| Some merged pull requests carry AI attribution (SKILL.md step 1 counts them), or the maintainer bars it | `no-ai-attribution`, with any other tool trailers they name added to its phrases. Its phrases name AI tools only, so a person's `Co-Authored-By:` line passes, and its `onFail: ask` makes a match Unsure for a maintainer rather than failing it. |
| The maintainer wants added TypeScript or JavaScript kept to the convention preset; never suggested from language alone | `conventions` (the `convention` preset), with `onFail: label` so it flags rather than fails; or, for invented fallbacks alone, `invented-fallbacks` instead, never both, since the preset already flags them |
| The user names TypeScript or JavaScript code conventions the preset lacks | A `code-patterns` rule of patterns, in the shape of `invented-fallbacks` |
| Pull requests for the same change are opened more than once | `no-duplicate` |
| The maintainer wants added TypeScript to use no `any` type; never suggested from language alone | `no-any` below; its `onFail: ask` makes such a pull request Unsure for a maintainer to accept, rather than failing it |
| A decision model is set up and pull requests often mix changes | `focused` |
| A decision model is set up and the repository keeps user docs beside its code | `docs` |
| A decision model is set up and contributors often open overlapping pull requests | `duplicates-open-pull-request` |

`no-forbidden-paths` fails maintainers too, so never list `.github/**` or another path the team edits on purpose unless the user asks.

When the user wants a rule to flag pull requests without failing them, such as a docs reminder, add `onFail: label` to it; size rules do this already. When they want a person to decide instead of the author fixing it, use `onFail: ask`. When they want a size limit to block, give it `onFail: fail` or `onFail: ask`.

To add a group to `sensitive-paths`, change the starter's rule. Writing `groups` replaces the default groups, `schema`, `auth`, `ci` and `locks`, so list each one to keep:

```yaml
  - check: sensitive-paths
    text: "Flag changes to sensitive paths: schema, auth, infra, ci, locks."
    groups:
      schema: { level: high, paths: ["**/migrations/**", "**/*.sql"] }
      auth: { level: high, paths: ["**/auth/**", "**/secrets/**"] }
      infra: { level: high, paths: ["terraform/**"] }
      ci: { level: medium, paths: [".github/**", "**/Dockerfile", "**/railway.json", "**/railway.toml"] }
      locks: { level: medium, paths: ["**/bun.lock", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml"] }
    reason: Schema, auth, infrastructure, CI and lockfile changes reach beyond what the diff shows.
    evidence: [maintainer-stated]
```

## Actions

Optional. Without `actions`, Triage only posts its comment and verdict label (a build status on Bitbucket Data Center). Each verdict has an ordered list of at most 20 steps; a verdict left out has none.

```yaml
actions:
  on: [opened, updated, checks, ready]   # optional; this is the default
  pass:
    - do: approve
      when: { author: [{ users: [<login>] }] }
    - do: request-review
      target: { to: users, users: [<login>] }
      when: { author: [external] }
  fail:
    - do: request-changes
  unsure:
    - do: request-review
      target: { to: codeowners }
```

`<login>` stands for a maintainer's login.

Only when `linked-issue` is on, and the maintainer wants it, Fail can close a pull request that names no issue and ask for changes on the rest. Its `fail` list replaces the one above:

```yaml
actions:
  fail:
    - do: close
      when: { linkedIssue: false }
    - do: request-changes
      when: { linkedIssue: true }
```

`on` takes any of `opened`, `updated`, `checks`, `ready`.

| `do` | `target` |
| --- | --- |
| `approve`, `merge`, `close`, `request-changes`, `nothing` | none |
| `comment` | `{ body: "text" }` |
| `labels` | `{ from: list, labels: [name, …] }` (no level label such as `risk: medium`) or `{ from: rules }` (one `rule: <id>` label per failed rule) |
| `request-review` | `{ to: codeowners }`, `{ to: users, users: [login, …] }` or `{ to: teams, teams: [org/team, …] }` |
| `assign` | as `request-review`, or `{ to: author }` |

A step may add `when`, and every condition in it must hold.

- `author`: list of `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`, `BOT`, the groups `maintainers`, `external`, `first-timers`, `bots`, `{ team: org/team }` or `{ users: [login, …] }`.
- `linkedIssue`: `true` or `false`.
- `ci`: list of `passing`, `failing`, `pending`, `none`.
- `files` / `lines`: `{ over: N, atMost: M }`, either or both, `atMost` more than `over`.

Triage carries out an action on its own only where the workspace allows that action for the repository (repository page, Actions Triage takes on its own); otherwise it waits for a person on Triage. Merge on Fail or Unsure, and Close on Unsure, always wait for a person, whatever the workspace allows. An `onFail: label` rule's label is added the same way, as an Add labels action. On Bitbucket Data Center, `labels` and `assign` have no effect (an `onFail: label` rule only adds its note), `request-review` to `teams` can't be carried out (it has no team reviewers), and `codeowners` means the pull request's default reviewers.

## Labels

Optional. Renames the verdict labels (at most 50 characters each). Defaults:

```yaml
labels:
  pass: "Triage: Ready"
  fail: "Triage: Not Ready"
  unsure: "Triage: Needs Human Review"
```

## Blocks and decide

Write these only when the user asks. A file holds `decide` or `actions`, never both.

A file with `code-review` on, or its own `decide`, runs the PR workflow: triage, then code review, then `decide` once. The file then decides code review for the repository, whatever its Code review switch says. It needs the workspace's Anthropic key and a place for code review to run; without them triage runs alone and approve and merge wait for a person. Code review always runs on Anthropic with the workspace's Anthropic key; `provider` has no effect. On GitHub, a pull request carrying the `pauseLabel` label starts no run until the label comes off, and one that can't be read is retried, never run unpaused. `pace` is accepted and has no effect.

```yaml
groups:
  maintainers: { association: [OWNER, MEMBER, COLLABORATOR] }
code-review:
  on: true
  for: [maintainers]
  when: { paths: ["!**/*.md", "!**/*.lock", "!**/package-lock.json", "!**/pnpm-lock.yaml"] }
  clean: { below: medium }
  provider: anthropic
pauseLabel: "corbits: pause"
decide:
  - { if: { triage: fail }, do: [request-changes, { do: comment, target: { body: "Please fix the failed rules." } }] }
  - { if: { triage: pass, all: clean }, do: approve }
  - { if: { code-review: findings }, do: [{ do: request-review, target: { to: codeowners } }] }
```

- `groups`: each named in lowercase words joined by hyphens, starting with a letter, at most 64 characters, with any of `association` (the author kinds under Actions), `teams` (`org/team`) and `users` (logins). The first group an author matches, in the order written, is theirs; they are in at most one. The built-in groups `maintainers`, `external`, `first-timers` and `bots` exist without being defined and match by author kind alongside it; defining one with that name replaces it. `everyone` is built in and always matches. A group or `everyone` can be named in `for`, `if.author` and a step's `when.author`. A step for a group Triage can't confirm the author is in doesn't run. Never let `approve` or `merge` rest on `everyone` alone.
- The `code-review` block takes only:
  - `on`: `true` or `false` (required).
  - `for`: list of groups; default everyone.
  - `when`: `triage` (`pass`, `fail`, `unsure` or a list of them), `rules` and `paths` (globs; any changed file matching is enough). A glob starting with `!` leaves out the files it matches; with only `!` globs, every other file matches. When the user asks to turn on `code-review`, suggest skipping pull requests that change only Markdown docs or lockfiles (`*.lock`, which covers `bun.lock`, plus `package-lock.json` and `pnpm-lock.yaml`), as in the example. `rules`: `pass` (the default) runs the review only once every rule in the file with `onFail: fail` that needs no model has passed, CI only when `ci-green` is one of them, and Triage's built-in checks (draft, changes requested) never hold it back; a failed one skips it, and while CI is still running it waits. `any` runs it whatever those rules say.
  - `clean`: `below` (`low`, `medium`, `high` or `critical`); findings below it don't count, and without it every finding counts. A code review with findings that count turns a Pass into Fail, and the `fail` actions run; an Unsure or Fail keeps its verdict, with the review's problems among its reasons and approve and merge held. `minConfidence` and `coverage` are refused.
  - `provider`: `anthropic`, `openai`, `xai`, `google`, `opencode` or `custom`.
- `pace`: `debounce`, `maxWait` (durations of at least 1, such as `30s`, `2m`, `24h`, `7d`), `perHead` (whole number ≥ 1), `cap: { runs, per }`, `backoff: { pushes, within, pause }`.
- `pauseLabel`: a label of at most 50 characters.
- `decide`: rules `{ if, do }`, in order. `if` sets at least one of `all: clean`, `triage`, `event` (a list of `opened`, `updated`, `checks`, `ready`), `author` (groups) and the outcome of a block that is on (`clean`, `findings`, `incomplete`, `skipped`, a list of them, or `{ findings: <severity> }`). `do` is `approve`, `merge`, `close`, `request-changes`, `nothing`, or a list of those and steps written as under Actions (`comment`, `labels`, `request-review` and `assign` need their `target`). `nothing` stands alone. `{ all: clean }` holds when at least one block ran and every block that ran is clean; skipped blocks never count, so it doesn't hold when every block was skipped or none is on. A rule that approves or merges without `triage` matches only Pass. Incomplete is never clean: a rule that approves or merges can't name `incomplete`, and only matches when nothing that ran is incomplete.

A file that uses `extends` can't hold `groups`, blocks, `pace`, `pauseLabel` or `decide`.

## extends

`extends: owner/name` starts from that repository's `.corbits-triage.yml` and sets only what differs (`PROJECT/slug` on Bitbucket). Use it only when the user names the repository. The repository must be connected to the same workspace and its own file must not use `extends`. The local check can't see either, so "valid" does not prove it can be read; tell the user to confirm it.

## Starter file

```yaml
# Corbits Triage policy.
rules:
  - check: max-files-changed
    text: Flag pull requests over 30 files changed.
    max: 30
    onFail: label
    reason: Large pull requests are hard to review.
    evidence: [maintainer-stated]
  - check: max-lines-changed
    text: Flag pull requests over 3,000 lines changed.
    max: 3000
    onFail: label
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
  - check: sensitive-paths
    text: "Flag changes to sensitive paths: schema, auth, ci, locks."
    reason: Schema, auth, CI and lockfile changes reach beyond what the diff shows.
    evidence: [maintainer-stated]
  - check: risk
    text: Flag high-risk pull requests and label medium-risk ones.
    reason: A risky change needs a maintainer's eye.
    evidence: [maintainer-stated]
```

## Extras, written out

```yaml
  - check: linked-issue
    text: Require a linked issue from Linear.
    tracker: linear
    reason: Every change is tracked in an issue.
    evidence: [maintainer-stated]
  - check: conventional-commits
    text: Titles follow Conventional Commits.
    fields: [title]
    reason: Pull requests are squash-merged, so the title becomes the commit.
    evidence: [maintainer-stated]
  - check: no-forbidden-paths
    text: Never accept changes to vendor/**.
    paths: ["vendor/**"]
    reason: Generated or vendored code is changed by its own process.
    evidence: [maintainer-stated]
  - check: no-duplicate
    text: Flag a pull request whose diff or commits match another open one.
    reason: Two pull requests for the same change waste a review; the earlier one stays.
    evidence: [maintainer-stated]
  - check: duplicates-open-pull-request
    text: Ask when a pull request overlaps another open one.
    reason: A near duplicate needs a person to pick which one goes on.
    evidence: [maintainer-stated]
  - id: no-ai-attribution
    check: text
    text: Titles, descriptions and commits carry no AI attribution.
    fields: [title, description, commits]
    failWhen: contains
    phrases:
      - "noreply@anthropic.com"
      - "Co-Authored-By: Claude"
      - "Co-Authored-By: GitHub Copilot"
      - "Co-Authored-By: Copilot"
      - "Co-Authored-By: ChatGPT"
      - "Co-Authored-By: Cursor"
      - "Co-Authored-By: Codex"
      - "Co-Authored-By: Gemini"
      - "Claude-Session:"
      - "claude.ai/code/session"
      - "Generated with Claude"
      - "Generated with [Claude"
    onFail: ask
    reason: No AI co-author lines, session trailers or links, or generated-with footers.
    evidence: [maintainer-stated]
  - id: conventions
    check: code-patterns
    text: Added code follows the repository's conventions.
    presets: [convention]
    onFail: label
    reason: Keeps added code free of invented fallbacks, nested ternaries, IIFEs and promise chains.
    evidence: [maintainer-stated]
  - id: invented-fallbacks
    check: code-patterns
    text: Added code handles a missing value instead of inventing an empty one.
    patterns:
      - id: more-invented-fallbacks
        language: typescript
        message: Invented fallback (an empty string, || [] or || 0); handle the missing value instead.
        ignores:
          [
            "**/*.{test,spec}.*",
            "**/{test,tests,Tests,__tests__}/**",
            "**/*.*{Test,Tests}/**",
          ]
        rule:
          any:
            - pattern: $X || []
            - all:
                - any:
                    - pattern: $X ?? ""
                    - pattern: $X ?? ''
                    - pattern: $X ?? ``
                    - pattern: $X || ""
                    - pattern: $X || ''
                    - pattern: $X || ``
                - not:
                    any:
                      - inside: { kind: template_substitution }
                      - inside:
                          {
                            kind: binary_expression,
                            has: { field: operator, regex: '^\+$' },
                          }
                      - inside:
                          {
                            kind: parenthesized_expression,
                            inside:
                              {
                                kind: binary_expression,
                                has: { field: operator, regex: '^\+$' },
                              },
                          }
                      - has: { field: left, kind: subscript_expression }
                      - has:
                          {
                            field: left,
                            kind: call_expression,
                            has:
                              {
                                field: function,
                                regex: '\.(at|get|getAttribute)$',
                              },
                          }
            - all:
                - pattern: $X || 0
                - not:
                    any:
                      - inside:
                          {
                            kind: binary_expression,
                            has: { field: operator, regex: "^[-+*/%]$" },
                          }
                      - inside:
                          {
                            kind: parenthesized_expression,
                            inside:
                              {
                                kind: binary_expression,
                                has: { field: operator, regex: "^[-+*/%]$" },
                              },
                          }
                      - inside: { kind: augmented_assignment_expression }
      - id: more-invented-fallbacks
        language: javascript
        message: Invented fallback (an empty string, || [] or || 0); handle the missing value instead.
        ignores:
          [
            "**/*.{test,spec}.*",
            "**/{test,tests,Tests,__tests__}/**",
            "**/*.*{Test,Tests}/**",
          ]
        rule:
          any:
            - pattern: $X || []
            - all:
                - any:
                    - pattern: $X ?? ""
                    - pattern: $X ?? ''
                    - pattern: $X ?? ``
                    - pattern: $X || ""
                    - pattern: $X || ''
                    - pattern: $X || ``
                - not:
                    any:
                      - inside: { kind: template_substitution }
                      - inside:
                          {
                            kind: binary_expression,
                            has: { field: operator, regex: '^\+$' },
                          }
                      - inside:
                          {
                            kind: parenthesized_expression,
                            inside:
                              {
                                kind: binary_expression,
                                has: { field: operator, regex: '^\+$' },
                              },
                          }
                      - has: { field: left, kind: subscript_expression }
                      - has:
                          {
                            field: left,
                            kind: call_expression,
                            has:
                              {
                                field: function,
                                regex: '\.(at|get|getAttribute)$',
                              },
                          }
            - all:
                - pattern: $X || 0
                - not:
                    any:
                      - inside:
                          {
                            kind: binary_expression,
                            has: { field: operator, regex: "^[-+*/%]$" },
                          }
                      - inside:
                          {
                            kind: parenthesized_expression,
                            inside:
                              {
                                kind: binary_expression,
                                has: { field: operator, regex: "^[-+*/%]$" },
                              },
                          }
                      - inside: { kind: augmented_assignment_expression }
    onFail: label
    reason: A fallback belongs only where a real default exists.
    evidence:
      - maintainer-stated
  - id: no-any
    check: code-patterns
    text: Added code uses no any type.
    patterns:
      - id: no-any
        language: typescript
        message: "`any` turns type checking off; name the type, or take unknown and narrow it."
        ignores:
          [
            "**/*.{test,spec}.*",
            "**/{test,tests,Tests,__tests__}/**",
            "**/*.*{Test,Tests}/**",
          ]
        rule: { kind: predefined_type, regex: "^any$" }
    onFail: ask
    reason: An any type hides the mistakes type checking is there to catch.
    evidence:
      - maintainer-stated
```

## Pull request check (GitHub)

Pin the policy-check action to the commit below. When a workflow's only event is `pull_request` and nothing could skip it for a pull request changing only `.corbits-triage.yml` (no `paths`, `paths-ignore`, `branches` or `types` filter, no workflow-level or job-level `if`, no other condition), add the `corbits-triage-policy` job to its `jobs`; otherwise, or when in doubt, write the whole file as `.github/workflows/corbits-triage-policy.yml`. When a workflow already uses this action, under any job id, leave it as it is. The check appears on each pull request as `<workflow name> / corbits-triage-policy`. A workflow written with the earlier job id, `check`, keeps reporting `Corbits Triage policy / check` until someone edits it; when that job is replaced with this one, change a branch protection rule or ruleset that requires the old name to the new one:

```yaml
name: Corbits Triage policy
on: pull_request
jobs:
  corbits-triage-policy:
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - uses: corbitsdev/corbits-triage/packages/policy-check-action@844696731de693ac70876ddf37cca016b065f25f
```
