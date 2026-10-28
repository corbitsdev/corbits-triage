# @corbits/policy-check-action

A GitHub Action that checks a repository's `.corbits-triage.yml` (or `.yaml`) as the hub reads it and marks each
problem on its line. On a pull request it also runs the rules of the base branch's policy that need no model through
the pr-triage definition, read-only: each failed rule is an error when its failure means Fail and a warning otherwise,
and the job summary lists every rule with its result and how many passed. Rules a model answers, and ci-green, which
the running job keeps pending, are listed as skipped. A base policy that `extends` another is not run here and gets a
notice, since Triage runs its rules. One that cannot be read fails the job with exit code 2, so a pull request that fixes
a broken base policy fails this check until it merges, and a maintainer merges it past the check. The job also fails
when a rule whose failure means Fail fails.
It needs no Triage account and no secrets, and works on pull requests from forks.

## Use

```yaml
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

Pin both actions to a full commit SHA; for this Action, a commit from `main`. The check is named `<workflow name> / corbits-triage-policy`; a workflow written with the earlier job id, `check`, keeps reporting `Corbits Triage policy / check` until it is edited, and when that job is replaced, a branch protection rule or ruleset that requires the old name must be changed to the new one. `github-token` defaults to the job's token. Locally, from here: `bun --conditions=intx-src src/main.ts <repository root> <owner/name>`;
with `GITHUB_EVENT_NAME=pull_request`, `GITHUB_EVENT_PATH`, `GITHUB_API_URL`, `GITHUB_TOKEN` and `GITHUB_STEP_SUMMARY` set it also runs the rules.

## Check locally

```sh
packages/policy-check-action/src/cli.ts check [--base <ref>]
```

Run inside any clone. It reads the policy from `<ref>` (default: origin's HEAD) and runs its rules that need no model
through the pr-triage definition twice: on the commits since the merge base (**Committed**, what triage sees once
pushed), then on those plus staged, unstaged and untracked changes (**Working tree**), unless there are none.
Host reads are answered from local git (a code-pattern rule reads each changed file from the head commit, or from the
working tree in the second run; a change adding code to more than 300 files leaves code-pattern rules unconfirmed), writes fail the run and are never sent, and no model is called. Skipped, besides
model rules: ci-green, no-merge-conflicts, linked-issue, hidden-content, regression-risk, no-duplicate, conventional-commits
when its fields include the title, and text rules reading the title or description, which need the pull request on its host. Rules do not depend on
the host, so it serves Bitbucket Data Center repositories as well.

Exit codes follow **Committed**; a failure only in the working tree prints a warning. 1 when a rule whose failure means Fail fails, 2 when the policy cannot be read, extends another, or the change
cannot be read, 0 otherwise.

## Test

```sh
bun --conditions=intx-src test packages/policy-check-action
```

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md)
- [PRODUCT.md](../../docs/PRODUCT.md#policy-file)
