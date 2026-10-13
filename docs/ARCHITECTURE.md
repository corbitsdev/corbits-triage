# Architecture

Triage is an app on [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, grants, credentials, workflow runs and
audit. Triage is a hub composition, a client-driven portal, and the workflow
and tool packages the portal deploys.

## Components

```
GitHub ──webhook──► Hub ──spawn──► Sidecar ──► pr-triage run
   ▲                 │  ▲                          │
   │                 │  └──── portal (/api) ───────┤
   └─── PR actions ──┴──────── GitHub reads, Dos ──┘
```

- **Hub** (`apps/hub`): the stock Interchange hub plus one composition
  block: `@corbits/webhooks` at `/api/hooks`, `@corbits/artifacts`,
  `@corbits/cron`. In the image it also serves the built portal, so one
  origin carries the portal, the API and GitHub webhooks. Triage adds:
  - **GitHub bridge**: verifies GitHub's HMAC on `/api/hooks/*`, updates the
    tenant's repository list from installation events, and hands pull
    request events to the coalescer. A pull request merged into the default
    branch marks the repository's other triaged heads `stale`. Temporary
    until `@corbits/webhooks` verifies GitHub signatures.
  - **Coalescer**: one pull request's burst of webhook events goes out as one
    mail to the tenant's live `pr-triage` deployment, as the tenant system
    sender, the same path cron uses. A new commit or a newly opened pull
    request waits only a few seconds.
  - **Reconciler**: on an interval, compares each enabled repository's open
    pull requests with the run logs and stored state, and re-queues every
    head without a verdict, and every stale head at most once per 15 minutes,
    in batches and under a per-tenant in-flight cap. A catch-up mail carries
    the decision-model answers recorded in the head's last verdict (from its
    run log) when the deployment runs the
    same workflow version and decision-model offering. It also replaces a
    `pr-triage` deployment with a fresh copy once its run log grows past a
    limit, and redeploys one that Interchange failed, after two minutes and
    at most three times an hour.
  - **Run recorder**: reads the live logs of tenants with a `pr-triage` run in
    flight and records each verdict and executed Do.
  - **App Manifest conversion**: GitHub returns a one-time code that must be
    exchanged server side, so the private key never reaches the browser. The
    `state` round-tripped through GitHub is signed by the hub and bound to the
    user who started setup, so no setup state is stored.
  - **Integration routes** under `/api/integrations/`: sign-in methods,
    GitHub App setup and installation sync, open pull requests, details,
    actions, Dos, previews and single pull request triage, latest verdicts,
    triage stats and timeline, the policy schema, invitations, and
    workflow deploy and versions. Each is described in `/openapi.json`. Pull request
    actions are synchronous: a maintainer's click must not wait on a
    workflow spin-up.
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`. Today it runs local child processes and restores
  them on boot; a remote provisioner replaces it without touching other code.
- **Portal** (`apps/web`): owns setup. After sign-in it converges the tenant,
  GitHub credentials, inference offering, workflow sources and deployments
  over stock hub routes. The hub seeds nothing for it. It is a wrapper over
  the routes; nothing is possible only through it.

## Workflows

Both are `onTrigger` mail listeners: each mail spawns a child run that
executes and ends.

- `pr-triage`: one mail names one pull request, or a batch of heads from
  the reconciler, and triages them.
- `pr-triage-historical`: one run that triages every open pull request of a
  repository. The portal starts it when a user turns triage on for the
  repository, or clicks **Triage open pull requests again**.

The bridge and the reconciler find the target by workflow name per tenant; no
deployment ids are configured anywhere.

## Triage pipeline

Every run is the same steps; the repository's policy decides what each
one does.

1. **facts**: reads the pull requests, their files, reviews, CI, the
   repository's docs and its contribution rules from GitHub.
2. **rules**: runs the hard rules and, unless one failed or the pull request
   is a draft or closed, builds the judged rules' questions; with none left
   to ask, it builds the verdict question instead.
3. **route**: skips the judge when no question needs asking.
4. **judge**: one System One call per request of questions that no carried
   answer matches. The only step that infers; see
   [DECISION_MODEL.md](DECISION_MODEL.md).
5. **parts**: reads the first answers and asks, through a second judge map,
   one question per file of each slice that failed focused and the verdict
   question over every rule's result.
6. **evaluate**: decides the verdict: Fail on a failed hard rule, Pass when every rule passes in a policy with no decision-model rule, otherwise
   Pass, Fail or Unsure from the verdict question. It renders the one comment
   and resolves the verdict's list of steps when the policy's When is woken, skipping each step not for the pull request's author.
7. **execute**: runs the Dos whose kind the `pr-triage` role holds on GitHub.
   Every other Do is held in the verdict (`held: true`) and the run finishes.
8. **mirror**: writes the verdict label (`triage: pass|fail|unsure`) when the `pr-triage` role holds the
   labels grant, and one marker comment when it holds the comment grant.

The hub reads which kinds the `pr-triage` system role is granted, `invoke` on
`triage-do:<kind>:<owner>/<name>`, and mails them with each trigger; the run
trusts them only from the hub's sender. Close on an Unsure verdict, and merge on anything but Pass,
are always held. The hub mails the policy twice: `pack` as stored, and `checkPack` in the shape a deployment built before steps reads, without the steps it would run wrongly. At start the hub
grants the role comment and labels on each repository still set to post
automatically, then drops that setting. A person holding the same grant approves a held Do, or one the run failed or could
not write, from the inbox: the hub checks the grants below and mails the
deployment the Do, its effect id, head and approver. That mail skips triage: an
`approval` action reads it, trusting only the hub's sender and checking the
effect id, and execute writes the Do unless GitHub already shows it; a close, merge,
comment or review is refused once the head has moved. The hub reads the
approval run's outcome back onto the verdict that held the Do. "Hide for me"
hides a Do in that browser only; nothing is sent.

Rules, routing, approval and evaluation are deterministic `action` steps. Facts,
execute and mirror reach GitHub through the GitHub tool's credential, so on
this Interchange pin they run as directors until actions can reach a bound
credential. Downstream work on a pull request is its own workflow, never a
step here.

## Tenancy and authority

A user's workspace is an Interchange tenant; repositories are tenant config
(`corbitsTriage.repos`) plus a per-repository policy and triage state,
both stored as tenant artifacts. Runs act under the grants materialized for
their deployment. GitHub access is a tenant credential bound to the GitHub
tool packages: the vault holds the App as `{"appId","privateKey"}` under
provider `github` and its webhook secret under provider `github-hook`. A
trusted sidecar adapter turns the App key into short-lived
installation tokens at the fetch boundary, so workflow and tool code never
hold it. Hub routes that read GitHub check the caller's `read` (or `use`)
grant on the same credential; routes that write to GitHub check `use`. Reads
(open pull requests, details, previews) use the secret on the caller's
behalf and never return it; writes are pull request actions and triage; approving a held Do checks only its kind's grant.
A pull request action from the portal that is a Do kind (comment, labels,
assign, request review, approve, request changes, close) also checks `invoke`
on `triage-do:<kind>:<owner>/<name>`, the repository name in lowercase; the
admin role holds `triage-do:*` from GitHub setup, and owners hold every grant. In a run, the repository's policy decides when to
approve, and only a head that passes with CI green is approved, from the
newest verdict. Where triage mirrors and its policy approves, a settled head
that may not be approved dismisses the approvals the approve Do made; one
dismissed on a head is not made again on it. Where it does not mirror, its
approvals are not dismissed.
Hub routes that reach GitHub for the portal use the same adapter.

## Data

- Interchange's own tables, artifacts and run logs hold tenants, credentials,
  deployments and runs.
- Artifacts: the policy (`check-pack/{owner}/{repo}`) and the triage state
  (`triage-state/{owner}/{repo}`) per repository. The triage state holds each
  open head's status (`new`, `queued`, `running`, `triaged`, `failed`,
  `stale`) and attempts.
- Triage tables, in the `corbits_triage` schema: `verdict` (verdicts per
  head, with the outcomes of the Dos their run executed), applied from `apps/hub/migrations` at hub start in one
  transaction under an advisory lock. Nothing else is stored: the GitHub App
  setup state is a signed token, and an invite is a stock invited principal
  the invitee accepts once signed in with a verified address, by a
  better-auth magic link when the hub sends email.
- Webhook replay protection uses the `@corbits/webhooks` table and a
  delivery-id cache in `HUB_DATA_DIR`.

## Vendoring

Interchange is vendored under `vendor/interchange` at a stock pin plus the
deltas in `vendor/interchange/VENDORED.md`, each with a kill date.
`tooling/vendor-diff-check.sh` fails on any other drift.
