# @corbits/triage-manager

A workspace's listener and a pull request's manager.

- **Listener** (`triageListener`, `triage-listener-<host>`): the hub mails it the pull requests it recorded. For each, it
  deploys a manager through Interchange's deploy route with its run token and wakes it with a mail that names only the
  pull request.
- **Manager** (`triageManager`, `triage-manager-<host>`): one live run per pull request, which runs only while it has
  work, and the only workflow that writes to the pull request. A mail starts a loop of passes: `take` claims the pull
  request and its pending events; each held Do approved since runs as pr-triage runs an approval; then pr-triage's own
  steps run on the newest mail the hub recorded for the head. A policy of only deterministic rules posts on that pass.
  One whose rules need the judge, or that asks for code review, posts once, after each of those has reported or given
  up. The next pass runs at once while an event is pending, or every 30 seconds while it waits for a reviewer. With a
  published judge, a pass deploys [`@corbits/triage-judge`](../triage-judge) and mails it the rules output; the pass
  that collects its report posts the judge's verdict as the judge made it, and so does every later pass on that head,
  which deploys no other judge. With code review, a pass then deploys the review and mails it the head's
  request; the pass that collects its report mirrors the verdict and posts the review together, and a later pass on
  that head posts the stored review again without deploying another. A reviewer that could
  not be mailed, failed or ran past its one-hour deadline leaves the verdict to go up alone; a judge the release does
  not publish posts nothing. `done` stops a reviewer this run deployed that is on an older head or past its deadline.
  The run's last step is its only end: it stops the run once `done` ends the pull request's claim, take is refused
  because another run holds it, or the passes fail or run out.

What each deploys next, a published workflow's source asset at one commit and the offerings it runs on (`Release`), is
read per host from `src/release.json`, which the portal writes into each published tree and the bundle keeps external,
as each body runs, so every entry imports without one: a listener body fails without the manager's, and a manager runs
code review only when the code review's is set, and the judge only when the judge's is set. The repository's own `release.json` is empty.

A run mails only through an agent step, so both mail through `mailAgentOf`, whose director makes no model call. The code
review a manager deploys is `codeReviewReviewer` in [`@corbits/pr-code-review`](../pr-code-review), and the judge is
`triageJudge` in [`@corbits/triage-judge`](../triage-judge). Each reports through its own `report`, whether or not it
finished, and posts nothing. The routes, the claim and the mail are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#workflows).

## Test

```sh
bun --conditions=intx-src test packages/triage-manager
```
