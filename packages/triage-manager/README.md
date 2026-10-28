# @corbits/triage-manager

A workspace's listener and a pull request's manager.

- **Listener** (`triageListener`, `triage-listener-<host>`): the hub mails it the pull requests it recorded. For each, it
  deploys a manager through Interchange's deploy route with its run token and wakes it with a mail that names only the
  pull request. A manager whose wake mail fails is cancelled, and the pull request's next event, or the reconciler
  re-queuing its head, deploys another.
- **Manager** (`triageManager`, `triage-manager-<host>`): one live run per pull request, which lives until its head has
  its final verdict, and the only workflow that writes to the pull request. A mail starts a loop of passes: `take` claims the pull
  request and its pending events; each held Do approved since runs as pr-triage runs an approval; then pr-triage's own
  steps run on the newest mail the hub recorded for the head. A policy of only deterministic rules posts on that pass.
  One whose rules need the judge, or that asks for code review, posts once, after each of those has reported or given
  up. The next pass runs at once while an event is pending. While the head waits for CI, or for a judge or code review
  it mailed, the next runs 30 seconds later, taking what arrived meanwhile: a check finishing, a reviewer's result, or a
  new head, whose pass starts over. Meanwhile the one triage comment reads In progress and names what it waits for; the
  verdict replaces it in place. A head that waited an hour for CI is decided anyway, and three hours after its claim a
  manager stops waiting: it decides, says what it stopped waiting for and runs no action on its own. The manager ends once its head
  has its final verdict and the policy's actions ran or were held, so an idle pull request has no manager. With a
  published judge, a pass deploys [`@corbits/triage-judge`](../triage-judge) once the host's checks have finished and
  mails it the rules output; while they run the head waits. The pass that collects its report posts the judge's
  verdict as the judge made it while the rules still need the judge, and so does every later pass on that head once
  the verdict is decided, deploying no other judge. With code review, a pass then deploys the review and mails it the
  head's request, or deploys it with the judge when it runs whatever the rules say and its `when` names every verdict; the
  pass that collects its report mirrors the verdict and posts the review together, and a later
  pass on that head posts the stored review again without deploying another. A reviewer that could not be mailed,
  failed or ran past its one-hour deadline leaves the verdict to go up alone and is deployed again on the next event;
  a judge the release does not publish posts nothing. `done` stops a reviewer this run deployed that ran past its
  deadline; the hub stops one on an older head when it records the newer head or when `done` reports it, and wakes a manager once a deadline
  passes with no manager up. The run's last step is its only end: it stops the run once `done` ends the pull
  request's claim, take is refused because another run holds it, or the passes fail or run out.

What each deploys next, a published workflow's source asset at one commit and the offerings it runs on (`Release`), is
read per host from `src/release.json`, which the hub writes into each published tree and the bundle keeps external,
as each body runs, so every entry imports without one: a listener body fails without the manager's, and a manager runs
code review only when the code review's is set, and the judge only when the judge's is set. The repository's own `release.json` is empty.

A run mails only through an agent step, so both mail through `mailAgentOf`, whose director makes no model call. The code
review a manager deploys is `codeReviewReviewer` in [`@corbits/pr-code-review`](../pr-code-review), and the judge is
`triageJudge` in [`@corbits/triage-judge`](../triage-judge). Each reports through its own `report` to the hub, whether or
not it finished, and posts nothing; the hub then wakes the pull request's manager. The routes, the claim and the mail are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#workflows).

## Test

```sh
bun --conditions=intx-src test packages/triage-manager
```
