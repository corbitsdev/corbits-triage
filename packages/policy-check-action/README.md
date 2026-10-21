# @corbits/policy-check-action

A GitHub Action that checks a repository's `.corbits-triage.yml` (or `.yaml`) as the hub reads it and marks each
problem on its line. On a pull request it also runs the rules of the base branch's policy that need no model through
the pr-triage definition, read-only: each failed rule is an error when its failure means Fail and a warning otherwise,
and the job summary lists every rule with its result and how many passed. Rules a model answers, and ci-green, which
the running job keeps pending, are listed as skipped. A base policy that `extends` another is not run, nor one that
cannot be read, which is a warning. The job fails when a rule whose failure means Fail fails.
It needs no Triage account and no secrets, and works on pull requests from forks.

## Use

```yaml
on: pull_request
permissions:
  checks: read
  contents: read
  pull-requests: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: corbitsdev/corbits-triage/packages/policy-check-action@main
```

`github-token` defaults to the job's token. Locally, from here: `bun --conditions=intx-src src/main.ts <repository root> <owner/name>`;
with `GITHUB_EVENT_NAME=pull_request`, `GITHUB_EVENT_PATH`, `GITHUB_API_URL`, `GITHUB_TOKEN` and `GITHUB_STEP_SUMMARY` set it also runs the rules.

## Test

```sh
bun --conditions=intx-src test packages/policy-check-action
```

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md)
- [PRODUCT.md](../../docs/PRODUCT.md#policy-file)
