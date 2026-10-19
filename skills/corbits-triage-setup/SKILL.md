---
name: corbits-triage-setup
description: Sets up or edits a repository's Corbits Triage policy file, .corbits-triage.yml. Use when someone wants to set up Corbits Triage, write, change or fix .corbits-triage.yml, add or remove triage rules, or choose what Triage does on Pass, Fail or Unsure.
---

# Set up Corbits Triage

Write a `.corbits-triage.yml` at the repository root that Corbits Triage accepts, then prove it with the same check the hub runs.

Use only the rules, fields and values in [reference.md](reference.md). Never invent a rule, key or value. If the user asks for something it does not list, say Triage can't do it.

## 1. Look at the repository

Find out, without asking:

- **Host and name** from `git remote get-url origin`. GitHub (`github.com`): `owner/name`. Bitbucket Data Center (`https://host/scm/PROJECT/repo.git` or `ssh://git@host:7999/PROJECT/repo.git`): `PROJECT/repo`. No remote: the host is unknown.
- **CI**: `.github/workflows/*.yml`, or another CI config (`.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`).
- **CODEOWNERS**: `CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS`.
- **Issue references**: issue links, `Fixes #123`, or keys like `ABC-123` in full commit messages (`git log --format=%B -n 50`) and branch names (`git branch -a`). A `(#123)` at the end of a subject is usually the pull request number from a squash merge, not an issue.
- **Commit style**: whether `git log --format=%s -n 50` mostly reads `feat: …`, `fix(scope): …`, and which types.
- **Vendored or generated code** checked in: `vendor/`, `third_party/`, `dist/`, `generated/`.
- **Existing file**: if `.corbits-triage.yml` or `.corbits-triage.yaml` exists, read it and edit it instead of starting over. If both exist, Triage reads only `.yml`; tell the user and suggest deleting the other.

## 2. Ask only what you can't tell

Ask in one message together with the proposal from step 3, giving your suggested answer for each. Ask:

- What should Triage do on Pass, Fail and Unsure beyond its verdict label (a build status on Bitbucket Data Center)? Suggest nothing, or asking code owners to review on Unsure when the repository has CODEOWNERS or is on Bitbucket Data Center (where code owners are its default reviewers).
- Should every pull request link an issue? Only when step 1 found issue references; suggest yes, with the tracker from "When to add".
- Should pull requests never change these paths, even from maintainers? Only when step 1 found vendored or generated code; suggest yes.
- Is a decision model set up in Corbits Triage (Settings → Models)? Only before adding `focused`, `docs` or a `model` rule.
- Is the repository on GitHub or Bitbucket Data Center? Only when there is no remote.
- On GitHub, add a pull request check that checks this file whenever it changes? Suggest yes.

If the user says to go ahead with defaults, use the suggested answers.

## 3. Propose the rules

Start from the four starter rules, which hold for any repository and need no model:

- `max-files-changed` (max 30) and `max-lines-changed` (max 3000): large pull requests are hard to review. Keep these limits unless the user names others. If the user would rather label large pull requests than fail them, make both `advisory: true`.
- `no-merge-conflicts`: a pull request with conflicts can't be merged as it is.
- `ci-green`: a change is not ready until CI passes. With no CI it passes on every pull request until CI is added, so keep it and say so.

Then add only the extras that fit, from "When to add" in [reference.md](reference.md), each with a one-line reason. Show the rules and actions as one line each and ask for a yes or changes before writing. Once the user agrees, each rule is `maintainer-stated`.

## 4. Write the file

Write `.corbits-triage.yml` at the repository root in the shape of [reference.md](reference.md). Every rule needs `check`, `text`, `reason` and `evidence`. Use `evidence: [maintainer-stated]` unless the user gives pull request numbers or links. Keep `text` and `reason` to one plain sentence each, and update `text` when you change a setting such as `max`. Copy phrase blocks from reference.md exactly. Leave out `actions` when there are none, and leave out a verdict that has no steps.

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
bun <checkout>/packages/policy-check-action/src/main.ts <repository root> <name from step 1>
```

Run it as its own command. With no remote, any `owner/name` such as `local/<folder>` works; the check only needs one. It prints one of:

- `.corbits-triage.yml is valid.`: done.
- `::error file=…,line=N::message`, one per problem: fix each and run it again.
- `No .corbits-triage.yml or .corbits-triage.yaml to check.`: the file was not written where you think; write it at the repository root and run it again.

Never report the file as done before it prints valid. With `extends`, valid does not prove the workspace policy id exists; tell the user to confirm it.

## 6. Finish

If the user said yes to the pull request check, write the workflow from [reference.md](reference.md) to `.github/workflows/corbits-triage-policy.yml`. It needs no secrets. There is none for Bitbucket Data Center. Then tell the user, in two lines, which rules are on and that the policy applies once the file is merged to the default branch.
