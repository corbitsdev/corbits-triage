# Architecture

Triage is an app on [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, grants, credentials, workflow runs and
audit. Triage is a hub composition, a client-driven portal, and the
workflow and tool packages the portal deploys.

## Components

```
GitHub ──webhook──► Web (proxy) ──/api──► Hub ──spawn──► Sidecar ──► pr-triage run
   ▲                    │                  │                              │
   └──── PR actions ────┴──── portal ──────┘◄──── GitHub reads/mirror ────┘
```

- **Hub** (`apps/hub`): the stock Interchange hub plus one composition
  block: `@corbits/webhooks` at `/api/hooks`, `@corbits/artifacts`,
  `@corbits/cron`. Triage adds three things on top:
  - **GitHub bridge**: verifies GitHub's HMAC on `/api/hooks/*`, updates
    the tenant's repository list from installation events, and delivers PR
    events to the tenant's live `pr-triage` deployment as the tenant system
    sender, the same path cron uses. Temporary until `@corbits/webhooks`
    verifies GitHub signatures.
  - **App Manifest conversion**: GitHub returns a one-time code that must
    be exchanged server side, so the private key never reaches the browser.
  - **Pull request actions**: comment, review, merge and close as a
    synchronous hub route. A maintainer click must not wait on a workflow
    spin-up.
- **Sidecars**: one per live deployment, started by the hub's
  `SidecarProvisioner`. v1 uses local processes; a remote provisioner
  replaces it without touching other code.
- **Portal** (`apps/web`): owns setup. After sign-in it converges the
  tenant, GitHub credentials, inference offering, workflow sources and
  deployments over stock hub routes. The hub seeds nothing for it.
- **Web** service: serves the portal and proxies `/api` to the hub, so
  both share one origin. It is the only public endpoint.

## Workflows

Both are `onTrigger` mail listeners: each event spawns a child run that
executes and ends.

- `pr-triage`: one PR event → facts, deterministic checks, classification,
  GitHub mirror.
- `pr-triage-historical`: catch-up over open PRs when a repository is added
  or on request.

The bridge finds the target by workflow name per tenant; no deployment ids
are configured anywhere.

## Tenancy and authority

A user's workspace is an Interchange tenant; repositories are tenant
config (`corbitsTriage.repos`) plus a per-repository check-pack artifact.
Runs act under the grants materialized for their deployment. GitHub access
is a tenant credential bound to the GitHub tool package; a trusted sidecar
adapter turns the App key into short-lived installation tokens at the fetch
boundary, so workflow and tool code never hold it. Hub-side PR actions
check the caller's `use` grant on the same credential.

## Classification

Deterministic state first (same inputs → same state), then priority and
attention rank. A judgment model is consulted only when the check pack
calls for it; confidence below the floor routes to a human. The mirror
writes labels and one marker comment; close and merge happen only on a
maintainer's action.

## Data

No Triage-owned domain tables beyond `corbits_github_manifest_state`
(session-bound conversion state). Decisions live in run state, tenant
config and artifacts. Webhook replay protection uses the
`@corbits/webhooks` table and a delivery-id cache in `HUB_DATA_DIR`.

## Vendoring

Interchange is vendored under `vendor/interchange` at a stock pin plus
the deltas in `vendor/interchange/VENDORED.md`, each with a kill date.
`tooling/vendor-diff-check.sh` fails on any other drift.

## Known gaps

- A hub restart leaves deployments marked live with no sidecar.
- INTR-647: the stock child-grant cap drops credential grants in
  `onTrigger` bodies; carried as a vendor patch.
