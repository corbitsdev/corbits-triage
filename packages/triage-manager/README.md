# @corbits/triage-manager

A pull request's manager: one live run per pull request, which runs only while it has work. Each hub mail runs one
body: `take` the pull request's pending events from the hub, run stage 1 as [pr-triage](../triage-workflows/README.md)'s
own facts, rules, evaluate and mirror steps over the mail, then `done`. The run stops itself when `done` ends the
pull request's claim. Rules that need the judge post nothing yet. Not deployed by anything yet.

## Use

`triage-manager-github` and `triage-manager-bitbucket-datacenter` build the definition for one host each:

```ts
import { workflow } from "@corbits/triage-manager/triage-manager-github";
```

The mail is pr-triage's plus `tenantId`, sent to the run's own address. The routes it calls and the claim are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#workflows).

## Test

```sh
bun --conditions=intx-src test packages/triage-manager
```
