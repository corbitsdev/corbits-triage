# Architecture

Corbits Triage reads each pull request against its repository's policy, posts a verdict and runs the policy's
actions. It runs on [Interchange](https://github.com/faremeter/interchange): a hub that holds tenants, credentials and
mail, and sidecars that run workflows.

```
GitHub, Bitbucket DC ──webhook──► Hub ◄──── portal, extension (/api)
        ▲                          │ mail
        │                          ▼
        │      sidecars: listener ──deploy──► manager ──deploy──► judge
        │                                       │  └──deploy──► code review (sandbox)
        └──── labels, comment, review, actions ─┘
```

## Parts

- **Hub** (`apps/hub`): the stock Interchange hub plus Triage's routes. It takes host webhooks, reads each
  repository's policy file, and mails the workflows. It also serves the portal. Every route it adds is in
  `/openapi.json`.
- **Portal** (`apps/web`): the web app. Workspaces, repositories, verdicts, held actions and code review. It only
  calls hub routes.
- **Extension** (`apps/extension`): a browser extension that checks the GitHub pull request being viewed against its
  policy and shows the result on the page.
- **Listener** (`packages/triage-manager`): one per workspace and host. It gets mail for pull requests that have no
  manager running and deploys one for each.
- **Manager** (`packages/triage-manager`): one per pull request. It runs the deterministic checks, deploys the judge
  and code review when the policy needs them, and is the only workflow that writes to the pull request.
- **Judge** (`packages/triage-judge`): a workflow that answers the rules that need a model. It returns its answers to
  the manager and writes nothing to the host.
- **Code review** (`packages/pr-code-review`, with a provider package such as `packages/pr-code-review-anthropic`): a
  workflow that reviews the diff for bugs and returns findings to the manager.
- **Sidecars and placement**: each deployment (the listener, a manager, a judge) runs in a local sidecar of its own,
  up to a cap. Past the cap it goes to a sandbox. Code review always runs in a sandbox. Sandboxes come from a
  provisioner package per backend (`packages/provisioner-*`).

Shared code lives in `packages/`: the policy and state types (`triage-contracts`), the host read and write tools
(`github-*`, `bitbucket-datacenter-*`), and the deterministic steps (`triage-workflows`).

## The policy

A repository's rules and actions live in `.corbits-triage.yml` on its default branch and nowhere else. The hub reads
the file, resolves it, and mails the resolved policy with each pull request. It keeps a read until a push changes the
file, or for at most a minute while the repository's webhook is silent. Each rule ends Pass, Fail or Unsure; the actions run on that
result. Nothing repository-specific is written into workflow code.

Whether an action runs on its own is decided by the workspace's role grants. Under the workspace's `policy` automation
the hub writes those grants from each policy file; under `ask` it grants only posting. An action the grants do not
allow is held for a person.

## How a pull request flows

1. A host webhook, or the reconciler re-reading open pull requests, names a pull request head. The hub records it.
2. If a manager is running for that pull request, the hub mails it. Otherwise it mails the host's listener, which
   deploys a manager and wakes it.
3. The manager runs the deterministic checks against the policy the hub mailed.
4. Unless that pass decides the head, the manager posts at once that it is in progress and what it is waiting for.
5. If the rules need the judge, the manager deploys it once the host's checks finish. If code review is on, it
   deploys code review in a sandbox. Each mails its result back.
6. While it waits, the manager edits its one comment in place. A head that waits only on CI ends the manager; the
   reconciler mails the head again once CI settles.
7. The manager posts the verdict label, the final comment and the review, reusing an earlier finding's thread when
   verification, prior discussion and the changes since the last review identify the same defect. It then runs the
   policy's actions where the grants allow and holds the rest for a person.
8. The manager ends. The next event on the pull request starts again at step 1.

Reviewing, fixing or cleaning up a pull request is a workflow of its own, started by mail or by an action's signal,
never a step inside the manager.

## Keeping it running

- **Reconciler**: a hub loop that re-reads open pull requests, mails heads no manager took, and ends runs that never
  started or ran past their limit.
- **Liveness**: the hub alarms when webhooks arrive but no manager takes them.
- **Release**: the hub publishes the workflows at boot and rolls a workspace's deployments when its credentials or
  catalog change.

## Three isolated parts

The deterministic checks, the judge and code review each have their own limits. One part's limit never changes what
another reads. Size is a risk signal: a crossed size limit labels a pull request and never makes it wait.

## Rules that always hold

The rules every change must keep, and how they are checked, are in [INVARIANTS.md](INVARIANTS.md).

## Hosts

Triage supports GitHub and Bitbucket Data Center. A repository record carries its `source`, and every mail names it.
Each host has its own listener, manager, judge and code review workflows. Setup for Bitbucket Data Center is in
[BITBUCKET_DATACENTER.md](BITBUCKET_DATACENTER.md).

## Stock Interchange and ours

Stock Interchange, vendored unchanged in `vendor/interchange` at the ref in `vendor/interchange/VENDORED.md`:

- the hub, tenants, sessions and auth;
- the credential vault, role grants and git tokens;
- mail routing, signals and the workflow runtime;
- sidecars, provisioning and the provisioner interface.

Ours, in `apps/*` and `packages/*`:

- the hub's webhook bridges, policy reads and Triage routes;
- the portal and the extension;
- the listener, manager, judge and code review workflows;
- the host tools and readers, and the provisioner backends.

Before building logic, look for an Interchange route or primitive that already does it. Where stock lacks a path,
raise it upstream rather than copying it. A change to `vendor/interchange` needs maintainer approval and is listed in
`VENDORED.md` and `tooling/vendor-diff-allowlist.txt`.

Secrets live in the hub vault and reach sidecars at launch and rotation. Nothing else reads or stores them. The GitHub
App key stays in the hub, which mints installation tokens for the sidecars. Code review, which runs a model over
untrusted code, holds only a token that can read contents and pull requests.
