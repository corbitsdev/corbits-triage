---
name: corbits-triage-setup
description: Sets up or edits a repository's Corbits Triage policy file, .corbits-triage.yml. Use when someone wants to set up Corbits Triage, write, change or fix .corbits-triage.yml, add or remove triage rules, or choose what Triage does on Pass, Fail or Unsure.
---

# Set up Corbits Triage

Write a `.corbits-triage.yml` at the repository root that Corbits Triage accepts, then prove it with the same check the hub runs.

Use only the rules, fields and values in [reference.md](reference.md), which lists every option the file accepts. Never invent a rule, key or value. If the user asks for something it does not list, say Triage can't do it.

The skill suggests from what the repository already does, with the numbers it measured, and the maintainer picks; a stricter house policy is the maintainer's choice, not the skill's.

## 1. Analyze the repository

Find out, without asking. On GitHub, the `gh` commands read the last 50 merged pull requests; run each from the repository root. Each signal says what it suggests.

- **Host and name** from `git remote get-url origin`. GitHub (`github.com`): `owner/name`. Bitbucket Data Center (`https://host/scm/PROJECT/repo.git` or `ssh://git@host:7999/PROJECT/repo.git`): `PROJECT/repo`. No remote: the host is unknown.
- **Size**: files and lines at the 90th percentile by nearest rank, each with the pull request at that rank, with lockfiles left out as the size rules leave them out. Suggest `max-files-changed` and `max-lines-changed` at those numbers rounded up, files to a multiple of 5 and lines to a multiple of 100, never below 1 and never above 30 files and 3,000 lines: "p90 is 23 files (#412), suggest 25".

  ```sh
  gh pr list --state merged --limit 50 --json number,changedFiles,additions,deletions,files --jq 'if length == 0 then "no merged pull requests" else map((.files | map(select(.path | test("(^|/)(bun\\.lockb?|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|go\\.sum|poetry\\.lock|uv\\.lock|Gemfile\\.lock|composer\\.lock)$")))) as $locks | {number, files: (.changedFiles - ($locks | length)), lines: (.additions + .deletions - ($locks | map(.additions + .deletions) | add // 0))}) | (length * 0.9 | ceil - 1) as $i | sort_by(.files)[$i] as $f | sort_by(.lines)[$i] as $l | "files \($f.files) (#\($f.number)), lines \($l.lines) (#\($l.number)); read \(map("#\(.number)") | join(" "))" end'
  ```

- **Issue references**: how many link an issue. GitHub counts what the rule with tracker `github` accepts: a `#12` at the start or after a space or `(` (`Closes #12`, `see #12`), a GitHub issue link, or a branch named like `123-title`. It reads titles, descriptions and branches; the rule also reads commit messages, which `gh pr list` can't return for 50 pull requests, so the count can be lower than what the rule accepts, never higher. Linear counts a title that starts with a key followed by a colon or in brackets (`ABC-123: …`, `[ABC-123] …`), a closing or `Refs` keyword, in any case, before an uppercase key (`Closes ABC-123`, `refs ABC-123`, not `fixes utf-8`), or a `linear.app` issue link. A branch named like a Linear issue (a 2 to 6 letter key, a number, then a slug of at least two words, such as `abc-123-fix-login`) is a hint, not a count: it is printed apart, and only when its key also starts a title in the Linear shape above or appears in a `linear.app` link among these pull requests, since `fix-123-login-bug` has the same shape. When most link one kind, suggest `linked-issue` with that tracker, `either` when both are common, and none when few do; the branch hint alone suggests nothing: "50 of 50 name a Linear key, suggest linked-issue with tracker linear".

  ```sh
  gh pr list --state merged --limit 50 --json number,title,body,headRefName --jq 'map({n: .number, h: .title, t: (.title + " " + .body), b: .headRefName}) | ([.[].h | scan("^(?:([A-Z]{2,6})-[0-9]+:|\\[([A-Z]{2,6})-[0-9]+\\])") | map(select(. != null)) | .[0]] + [.[].t | scan("linear\\.app/[^/ ]+/issue/([A-Za-z]{2,6})-[0-9]+") | .[0] | ascii_upcase] | unique) as $keys | map(select((.t | test("(^|[\\s(])#[0-9]+\\b|github\\.com/[^\\s/]+/[^\\s/]+/issues/[0-9]+")) or (.b | test("^[0-9]+-")))) as $github | map(select((.h | test("^([A-Z]{2,6}-[0-9]+:|\\[[A-Z]{2,6}-[0-9]+\\])")) or (.t | test("\\b(?i:close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?)\\s+[A-Z]{2,6}-[0-9]+\\b|linear\\.app/[^/ ]+/issue/")))) as $linear | map(select(.b | test("^[a-z]{2,6}-[0-9]+-[a-z0-9]+(-[a-z0-9]+)+$"; "i")) | select((.b | capture("^(?<k>[A-Za-z]+)-").k | ascii_upcase) as $k | any($keys[]; . == $k))) as $branch | "of \(length): github \($github | length) (\($github | map("#\(.n)") | join(" "))), linear \($linear | length) (\($linear | map("#\(.n)") | join(" "))); hint: \($branch | length) branches named like a Linear issue with a key from a Linear title or link"'
  ```

- **Merge style**: how many of the last 50 subjects on the default branch end in `(#N)`, read from `origin` after a fetch that deepens a shallow clone. When most do, pull requests are squash-merged and their commits never reach the branch: suggest `fields: [title]` on `conventional-commits`. The block prints how many commits it read and the pull request numbers it found; when it read fewer than 50, the history is cut short, so say so with the number and suggest nothing from it.

  ```sh
  git remote set-head origin --auto >/dev/null
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')"
  git fetch --unshallow origin 2>/dev/null || git fetch origin "$branch"
  squashed="$(git log --first-parent --format=%s -n 50 "origin/$branch" | grep -oE '\(#[0-9]+\)$' | tr -d '()')"
  echo "$(printf '%s' "$squashed" | grep -c .) of $(git rev-list --first-parent --count --max-count=50 "origin/$branch"): $(echo $squashed)"
  ```

- **Commit style**: how many titles start `type: `, `type(scope): ` or `type!: ` with a type from the rule's default list (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `build`, `style`, `revert`), in any case, as the rule reads them. When most do, suggest `conventional-commits`; when about half do, suggest it with `onFail: label`, or leaving it out: "29 of 50 titles are conventional, suggest conventional-commits off or onFail label".

  ```sh
  gh pr list --state merged --limit 50 --json number,title --jq 'map(select(.title | test("^(feat|fix|refactor|perf|docs|test|chore|ci|build|style|revert)(\\([^)]*\\))?!?: "; "i"))) as $c | "\($c | length) of \(length): \($c | map("#\(.number)") | join(" "))"'
  ```

  This prints every word used in that shape and how often. When a change type outside the default list, such as `deps`, starts more than one title, suggest `types` listing the whole default list plus each such type, since `types` replaces the default list; a word that is not a change type, such as `WIP`, stays out. With no type outside the default list, suggest no `types`.

  ```sh
  gh pr list --state merged --limit 50 --json title --jq 'map(.title | capture("^(?<t>[A-Za-z]+)(\\([^)]*\\))?!?: ").t | ascii_downcase) | group_by(.) | map("\(.[0]) \(length)") | join(", ")'
  ```

  When the repository is not squash-merged, the rule also reads each commit, so count conventional subjects among the last 200 non-merge commits on the default branch, with the same types, as a stand-in for the pull requests' own commits. When the titles are conventional but most commits are not, suggest `fields: [title]`: "48 of 50 titles but 61 of 200 commits are conventional, suggest fields: [title]". As with merge style, a count of commits read below 200 means a cut-short history: say so with the number.

  ```sh
  git remote set-head origin --auto >/dev/null
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')"
  git fetch --unshallow origin 2>/dev/null || git fetch origin "$branch"
  echo "$(git log --no-merges --format=%s -n 200 "origin/$branch" | grep -ciE '^(feat|fix|refactor|perf|docs|test|chore|ci|build|style|revert)(\([^)]*\))?!?: ') of $(git rev-list --no-merges --count --max-count=200 "origin/$branch")"
  ```

- **Authors**: who opened them. The people who open most are the candidate maintainers for actions, alongside CODEOWNERS.

  ```sh
  gh pr list --state merged --limit 50 --json author --jq 'group_by(.author.login) | map("\(.[0].author.login) \(length)") | join(", ")'
  ```

- **Vendored or generated code**: which `vendor/`, `third_party/`, `dist/` or `generated/` folders are checked in, and which pull requests changed them. Checked in and changed in some: suggest a `sensitive-paths` group, since the team changes it on purpose. Checked in and changed in none: list `no-forbidden-paths` as an option only, for a person to confirm; it fails maintainers too, so it is never written without one.

  ```sh
  git ls-files | awk -F/ '{p=""; for(i=1;i<NF;i++){p=p $i "/"; if($i ~ /^(vendor|third_party|dist|generated)$/){print p; break}}}' | sort -u
  ```

  ```sh
  gh pr list --state merged --limit 50 --json number,files --jq 'map(select(any(.files[]; .path | test("(^|/)(vendor|third_party|dist|generated)/")))) | "\(length): \(map("#\(.number)") | join(" "))"'
  ```

- **AI attribution**: how many titles and descriptions carry one of the `no-ai-attribution` rule's phrases in reference.md: `noreply@anthropic.com`, a `Co-Authored-By:` naming Claude, Copilot, ChatGPT, Cursor, Codex or Gemini, `Generated with Claude`, `Claude-Session:` or a `claude.ai/code/session` link. A plain `Co-Authored-By:` for a person does not count. Above 0, suggest `no-ai-attribution` with the number, since the rule would have asked about each of them; at 0, list it as an option only.

  ```sh
  gh pr list --state merged --limit 50 --json number,title,body --jq 'map(select((.title + " " + .body) | test("noreply@anthropic\\.com|Co-Authored-By: (Claude|GitHub Copilot|Copilot|ChatGPT|Cursor|Codex|Gemini)|Claude-Session:|claude\\.ai/code/session|Generated with \\[?Claude"; "i"))) | "\(length): \(map("#\(.number)") | join(" "))"'
  ```

- **Languages**: whether `git ls-files` lists TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) or JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) of the repository's own. Nothing is suggested from language alone; step 3 names the options it opens.
- **CI**: `.github/workflows/*.yml`, or another CI config (`.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`). Note whether a workflow already uses `corbitsdev/corbits-triage/packages/policy-check-action`, under any job id (step 6). Otherwise note a GitHub workflow whose only event is `pull_request`, and whether anything could skip it for a pull request changing only `.corbits-triage.yml`: a `paths`, `paths-ignore`, `branches` or `types` filter on the trigger, a workflow-level or job-level `if`, or any other condition (step 6).
- **CODEOWNERS**: `CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS`. It suggests requesting code owners' review on Unsure, and the people it names (`@login`, not `@org/team`) are candidate maintainers.
- **Existing file**: if `.corbits-triage.yml` or `.corbits-triage.yaml` exists on the default branch, read it; step 4 edits it in place. If both exist, Triage reads only `.yml`; tell the user and suggest deleting the other.

With no merged pull requests, or on Bitbucket Data Center, where `gh` reads nothing, the baseline is the six rules in reference.md's "Starter file" with its 30 files and 3,000 lines. The history signals then come from the default branch's last 50 commit messages and the remote branch names alone, with their numbers and how many commits were read:

```sh
git remote set-head origin --auto >/dev/null
branch="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')"
git fetch --unshallow origin 2>/dev/null || git fetch origin "$branch"
echo "$(git rev-list --count --max-count=50 "origin/$branch") commits read from origin/$branch"
git log --format=%B -n 50 "origin/$branch"
git branch -r
```

## 2. Suggest, and let the maintainer pick

Present the suggestions in one message, one line each with its number and reason, starting from the six starter rules with the measured limits, then the options step 1 found a signal for, then actions. Ask the maintainer to pick, change or drop each. Also ask what step 1 can't tell:

- Who are the maintainers, for actions that name them? Suggest the candidates from step 1.
- What should Triage do on Pass, Fail and Unsure beyond its comment and verdict label (a build status on Bitbucket Data Center)? Suggest nothing, or requesting code owners' review on Unsure when step 1 found CODEOWNERS or the repository is on Bitbucket Data Center (where code owners are its default reviewers). reference.md's "Actions" lists every step.
- Is a decision model set up in Corbits Triage (Settings → Triage → Decision model)? Only before suggesting `focused`, `docs`, `duplicates-open-pull-request` or a `model` rule.
- Is the repository on GitHub or Bitbucket Data Center? Only when there is no remote.
- On GitHub, unless a workflow already runs the policy check, add a pull request check that checks this file and runs its rules that need no model on every pull request?

When nobody can answer, as in a run with no person to reply, write the suggested values, add no actions beyond what a suggestion names, add no rule that needs a model or that step 1 lists only as an option, and list every suggestion you wrote under a `Waiting on you` heading in the pull request body (step 6), each with its number.

## 3. Choose the rules

Write only what the maintainer picked, or, with nobody to answer, what step 1 suggested. Each option and its settings is in [reference.md](reference.md), with one line on when it fits. For TypeScript or JavaScript, name `conventions`, and for TypeScript `no-any`, as options the maintainer may want; offer `invented-fallbacks` only when `conventions` is not picked, since the `convention` preset already flags invented fallbacks. Write them only when the maintainer picks them. With no CI, `ci-green` passes until CI is added; keep it and say so.

## 4. Write the file

Write `.corbits-triage.yml` at the repository root in the shape of [reference.md](reference.md). Every rule needs `check`, `text`, `reason` and `evidence`. Keep `text` and `reason` to one plain sentence each, and update `text` when you change a setting such as `max`. Write each rule picked in step 3 from the block or table row reference.md documents for it: the "Starter file", "Extras, written out", the `sensitive-paths` `groups` example under "Rules", and the "Built-in rules" table for `hidden-content`, `regression-risk`, `focused`, `docs` and the other rules with no block, each written as `check`, `text`, `reason`, `evidence` and the settings its row lists. Write nothing reference.md does not document. Leave out `actions` when there are none, and leave out a verdict that has no steps.

A rule the maintainer confirms has `evidence: [maintainer-stated]`, with their pull request numbers or links if they give any. A rule written from a suggestion nobody confirmed cites what was measured: its `evidence` lists up to 20 of the pull request numbers its step 1 command printed (`"#123"`), such as the one at the 90th percentile, and its `reason` says in one line what was measured, such as `90% of the last 50 merged pull requests change at most 25 files.` The file accepts only pull request references, `https://` links and `maintainer-stated` as evidence; any other word, such as `history`, is refused. A starter rule with nothing measured keeps `maintainer-stated` and is listed under `Waiting on you`.

When the file already exists, edit it in place rather than rewriting it:

- Keep every rule whose id still fits, with its id, `text` and `evidence`, so its history and labels carry on. Remove one that no longer fits, such as `no-forbidden-paths` for a folder that is gone, and name it with the reason in the pull request.
- Add a picked rule only when the file has no rule with its id or `check`.
- A measured size limit is a suggestion like any other; when it changes the file's limit, the pull request names the old and new number.
- A file with `decide` keeps it and gets no `actions`. An existing `actions` block is kept, and the pull request names any step you change.
- The file holds at most 8 rules of its own, counting the ones it has. When the picked rules would take it past that, keep every existing rule and drop new ones in this order until it fits: `model` rules, `no-any`, `invented-fallbacks`, `conventions`, `no-ai-attribution`, then other `text` rules. Name each dropped rule in the pull request.

## 5. Validate and fix

Run the same check the hub runs. It needs Bun 1.4 or later (`bun --version`; install from https://bun.sh).

Find a Corbits Triage checkout: if this skill sits at `<checkout>/skills/corbits-triage-setup/SKILL.md` and `<checkout>/packages/policy-check-action` exists, use that `<checkout>`. Otherwise clone one into a new empty folder, and use the path it prints as `<checkout>`:

```sh
checkout="$(mktemp -d)/corbits-triage"
git clone --depth 1 https://github.com/corbitsdev/corbits-triage "$checkout"
echo "$checkout"
```

If `<checkout>/node_modules` is missing, install what the check needs:

```sh
(cd <checkout> && bun install --frozen-lockfile --filter @corbits/policy-check-action)
```

Then:

```sh
bun --conditions=intx-src <checkout>/packages/policy-check-action/src/main.ts <repository root> <name from step 1>
```

Run it as its own command. With no remote, any `owner/name` such as `local/<folder>` works; the check only needs one. It prints one of:

- `.corbits-triage.yml is valid.`: done.
- `::error file=…[,line=N[,col=M]]::message`, one per problem: fix each and run it again.
- `No .corbits-triage.yml or .corbits-triage.yaml to check.`: the file was not written where you think; write it at the repository root and run it again.

Never report the file as done before it prints valid. With `extends`, valid does not prove the repository it names can be read; tell the user to confirm it.

## 6. Finish

If a workflow already uses `corbitsdev/corbits-triage/packages/policy-check-action`, under any job id, leave it as it is and tell the user it already runs; a branch protection rule may require its name. Otherwise, if the user said yes to the pull request check, add the job from reference.md's "Pull request check (GitHub)", pinned to the commit it gives. When a workflow's only event is `pull_request` and nothing could skip it for a pull request changing only `.corbits-triage.yml` (no `paths`, `paths-ignore`, `branches` or `types` filter, no workflow-level or job-level `if`, no other condition), add the job to it; otherwise, or when in doubt, write the workflow to `.github/workflows/corbits-triage-policy.yml`. It needs no secrets. There is none for Bitbucket Data Center.

When the change goes up as a pull request, its description names each rule removed from an existing file and why, each changed limit and action step, and each rule dropped for the cap. If nobody could answer, it ends with a `Waiting on you` heading that lists every suggestion written, with its number, so a maintainer can change it before merging.

Then tell the user, in two lines, which rules are on and that the policy applies once the file is merged to the default branch.
