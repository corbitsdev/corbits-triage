# @corbits/triage-judge

The judge a pull request's manager deploys (`triageJudge`, `triage-judge-<host>`). The manager mails it the rules output
for one head. It runs those chunks through System One, then focused's follow-up questions, then evaluate, and reports
the verdict — including the answers a later pass can replay — through the reviewer-result route. It mails the manager
a wake-up and stops, whether or not the judge finished. It posts nothing to the pull request.

Only the manager that deployed it may mail it. Its definition declares `create` on `triage-manager:result` and `manage`
on its own run.

## Test

```sh
bun --conditions=intx-src test packages/triage-judge
```
