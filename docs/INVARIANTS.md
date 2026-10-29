# Invariants

The rules Triage keeps on every pull request, whatever order its events arrive in. Breaking one is a defect. A pull
request that changes how Triage keeps a rule names the rule.

## Rules

- **R1** One final verdict per pull request head, for the current head. Checked by `tests/model/rules.postgres.test.ts`: once the pull request settles it has exactly one current Triage comment, which is a verdict naming the head, and no waiting label.
- **R2** Triage approves or merges only on Pass with a complete code review that meets the policy's findings condition, all for the current head. No automated check yet.
- **R3** Every host write happens once under its effect id. Checked by `tests/model/rules.postgres.test.ts` over every write the pull request received, whichever pass made it: no Triage comment is created while one is current, unless that one was superseded, and no label is added while it is on.
- **R4** Unreadable input never passes or approves. No automated check yet.
- **R5** Nothing is left running after the final post. Checked by `tests/model/rules.postgres.test.ts`: once the pull request settles, none of its managers is live, no live manager was deployed for no single pull request, and no mail for it was lost to a run that had ended. Settling delivers every queued mail, so no mail is left waiting by construction.
- **R6** An older run never overwrites a newer head's comment, label, status or approval. No automated check yet.
- **R7** A pull request waiting on CI or a reviewer always gets its verdict. No automated check yet; R1's check covers a head waiting on CI.
- **R8** GitHub and Bitbucket Data Center behave the same except where documented. No automated check yet.
- **R9** Every reader of the policy agrees on what it says. No automated check yet.
- **R10** The portal shows only what the hub says. No automated check yet.

A label may come off and go back on while a pass runs; R1 judges the labels a pull request ends with, and R3 only an
add while the label is on.

## How the model check works

`tests/model/` runs the real `triage-listener-github` and `triage-manager-github` definitions in the test's process
through Interchange's `runLocal` and the stock step invoker. They run against the hub's own intake and manager routes on
a database of their own and the chain's fake GitHub. Steps authorize through Interchange's credentials-backed authorize
against the grants a deployed run holds: those its definition's walk yields, its credential bindings, and the grants
recorded for it at deploy.

Events played: open, push, CI pending, success, failure or cancelled on the head, CI finishing on an older head, an
edit, conversion to draft and back to ready, a mail delivered twice, and which queued mail is delivered next. Every
sequence of up to two of them after the open is played, and 300 seeded random walks of ten. A pull request settles
once it is ready for review, CI on its head has finished and every mail has been delivered. A failure names its
sequence, and a walk's seed, so it replays; a run that ends other than completed, or a sequence that throws, fails too.

Stand-ins, and what they leave out:

- Stock's deploy route records the run, its definition's grant requirements as creator grants, and its run tokens. It
  checks the caller holds the deploy and the asset's read and refuses a body that names no published release, but it
  does not resolve the requirements against the creator's own grants. It ties each manager it deploys to the pull
  request named by the mail the listener was running, which R5 reads.
- Stock's stop-run route checks the caller's `manage` grant and ends the run at once, so the window while a cancelled
  run still runs is not played.
- Mail waits in the test's queue. Stock's `mailAccept` check and its hold on mail to a just-deployed run are bypassed;
  mail to a run that has ended is dropped or refused, as stock does.
- Webhooks enter at the hub's intake as the coalescer flushes them. The bridge and coalescer do not run; the bridge's
  rule that a draft's webhooks are dropped is played by the test.
- The intake's hooks are fixed: the listener is always routable, no pull request is paused, the App's login is fixed,
  and code review and backlog reads are not served.
- Runs use the real clock, so CI's start grace, the manager's poll and its lifetime are not played.
- The policy is deterministic only, with no judge, no code review and no model.

## Not covered by the model check

- Interleaving inside a pass: a push or a second manager while a pass runs, and contention for the claim.
- The cancellation window, `mailAccept` and the listener's `onTrigger` admission, and the real coalescer.
- A fake clock for CI and lifetime timers.
- Judge and code review stand-ins, and so R2.
- Every sequence of three events and more, which takes longer than CI allows on one shard; the seeded walks reach some.
