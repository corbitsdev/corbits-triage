# @corbits/triage-manager

A workspace's listener and a pull request's manager.

- **Listener** (`triageListener`, `triage-listener-<host>`): the hub mails it the pull requests it recorded. For each, it
  deploys a manager through Interchange's deploy route with its run token and wakes it with a mail that names only the
  pull request.
- **Manager** (`triageManager`, `triage-manager-<host>`): one live run per pull request, which runs only while it has
  work, and the only workflow that writes to the pull request. A mail starts a loop of passes: `take` claims the pull
  request and answers the newest mail the hub recorded for it, pr-triage's own steps run on that mail (an approval, a
  head held for CI, or a pull request to triage), then `done`. The next pass runs at once while an event is pending, or
  every 30 seconds while it waits for its code review. With code review, a pass deploys the review and mails it the
  head's request; the pass that collects its report mirrors the verdict and posts the review together. A review that
  could not be mailed, failed or ran past its one-hour deadline leaves the verdict to go up alone. The run stops itself
  when `done` ends the pull request's claim.

What each deploys next, a published workflow's source asset at one commit and the offerings it runs on (`Release`), is
set by the release build as `TRIAGE_RELEASE`, per host: the listener entries need the manager's, and the manager
entries deploy code review when the code review's is set.

A run mails only through an agent step, so both mail through `mailAgentOf`, whose director makes no model call. The code
review a manager deploys is `codeReviewReviewer` in [`@corbits/pr-code-review`](../pr-code-review); it reports through
`report` here, whether or not its review finished, and posts nothing. The routes, the claim and the mail are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#workflows).

## Test

```sh
bun --conditions=intx-src test packages/triage-manager
```
