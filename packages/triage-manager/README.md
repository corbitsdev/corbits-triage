# @corbits/triage-manager

A workspace's listener and a pull request's manager.

- **Listener** (`triageListener`, `triage-listener-<host>`): the hub mails it the pull requests it recorded. For each, it
  deploys a manager through Interchange's deploy route with its run token and wakes it with a mail that names only the
  pull request at once; Interchange holds that mail until the manager's deploy is recorded. A manager that never comes
  up gives up its pull request once that hold lapses; its next event, or the reconciler re-queuing its head, deploys
  another.
- **Manager** (`triageManager`, `triage-manager-<host>`): one live run per pull request, which lives until its head has
  its final verdict or waits only on CI, and the only workflow that writes to the pull request. A mail starts a loop of passes: `take` claims the pull
  request and its pending events; each held Do approved since runs through the shared approval step; then the shared
  triage steps run on the newest mail the hub recorded for the head. A policy of only deterministic rules posts on that pass.
  One whose rules need the judge, or that asks for code review, posts once, after each of those has reported or given
  up. The next pass runs at once while an event is pending. While a judge or code review it mailed is out and within its
  deadline, the next runs 30 seconds later, taking what arrived meanwhile: a check finishing, a reviewer's result, or a
  new head, whose pass starts over. A head that waits only on CI posts that it waits and its manager ends; the next
  check event, or the hub's reconcile pass once CI settles, the start grace passes or the hour is up, wakes a fresh
  manager for it. Meanwhile the one triage comment reads In progress and names what it waits for; the verdict replaces
  it in place. A head that waited an hour for CI is decided anyway, and a manager its reviewers keep alive three hours
  after its claim stops waiting: it decides, says what it stopped waiting for and runs no action on its own. The manager
  ends once its head has its final verdict and the policy's actions ran or were held, so an idle pull request has no manager. With a
  published judge, a pass deploys [`@corbits/triage-judge`](../triage-judge) once the host's checks have finished and
  mails it the rules output; while they run the head waits. The pass that collects its report posts the judge's
  verdict while the rules still need the judge, its judgement as the judge made it and its Dos made again from the
  pass's facts, and so does every later pass on that head once the verdict is decided, deploying no other judge. A
  manager that stopped waiting deploys no judge. With code review, a pass then deploys the review and mails it the
  head's request, or deploys it with the judge when it runs whatever the rules say and its `when` names every verdict; the
  pass that collects its report mirrors the verdict and posts the review together, and a later
  pass on that head posts the stored review again without deploying another. A reviewer that could not be mailed,
  failed, ran past its one-hour deadline or whose run ended before it reported leaves the verdict to go up alone; a
  judge is deployed again on the next event, and a code review is not deployed again on that head until it changes or a
  Review again asks for one. The in-progress comment for code review leaves a verdict already posted on the head in
  place while the pass's rules still give it; a judge the release does not publish posts nothing. `done` stops a reviewer this
  run deployed that ran past its deadline or whose run ended; the hub stops one on an older head when it records the
  newer head or when `done` reports it, and wakes a manager once a deadline passes with no manager up. The run's last step is its only end: it stops the run once `done` ends the pull
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
