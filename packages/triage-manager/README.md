# @corbits/triage-manager

A workspace's listener and a pull request's manager.

- **Listener** (`triageListener`): the hub mails it each pull request. It deploys that pull request's manager through
  Interchange's deploy route with its run token and hands the hub's mail on to it.
- **Manager** (`triageManager`): one live run per pull request, which runs only while it has work, and the only workflow
  that writes to the pull request. Each mail runs one body: `take` claims the pull request and its pending events from
  the hub, stage 1 runs as [pr-triage](../triage-workflows/README.md)'s own facts, rules and evaluate, then `done`. With
  code review, a pass deploys the review and mails it the head's request; the pass that collects its report mirrors the
  verdict and posts the review together. The run stops itself when `done` ends the pull request's claim. Rules that need
  the judge post nothing yet.

What each deploys next, a published workflow's source asset at one commit and the offerings it runs on (`Release`), is
fixed when the release is published:

```ts
import { triageListener } from "@corbits/triage-manager/triage-listener";
import { triageManager } from "@corbits/triage-manager/triage-manager";

export const listener = triageListener({ id: "triage-listener-github", manager: release.manager });
export const manager = triageManager({ id: "triage-manager-github", sources: ["github"], review: release.codeReview });
```

A run mails only through an agent step, so both mail through `mailAgentOf`, whose director makes no model call. The code
review a manager deploys is `codeReviewReviewer` in [`@corbits/pr-code-review`](../pr-code-review); it reports through
`report` here and posts nothing. The routes, the claim and the mail are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#workflows).

## Test

```sh
bun --conditions=intx-src test packages/triage-manager
```
