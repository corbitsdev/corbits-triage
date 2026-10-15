# Bitbucket Data Center

How a workspace connects one Bitbucket Data Center instance and turns triage on
for its repositories. Every step is a hub route under
`/api/integrations/bitbucket-datacenter/{tenantId}`, listed in `/openapi.json`; the portal
is a wrapper over them.

## What is stored where

- The instance URL is `bitbucketDatacenter.baseUrl` in the workspace's `corbitsTriage`
  config, with `bitbucketDatacenter.user`, the slug the token acts as, whose
  own webhook events never wake triage. One connection per workspace.
- The token is the stock credential `bitbucket-datacenter` (type `api_key`) on the stock
  provider `bitbucket-datacenter` (plugin `http`, `apiBaseUrl` = the instance URL).
- The webhook secret is the stock credential `bitbucket-datacenter-hook`, with
  `metadata.webhook` as the GitHub hook credential has it.
- Repositories are records in `corbitsTriage.repos` with `source: "bitbucket-datacenter"`,
  named `PROJECTKEY/slug` (for example `TRI/widgets`), with `defaultBranch` and,
  when triage created the webhook, `webhookId`.

## Workflow

Bitbucket repositories are triaged by the `pr-triage-bitbucket-datacenter`
workflow, the same steps as `pr-triage-github` built over the Bitbucket tools
(`@corbits/triage-workflows`'s `prTriage({ sources })`). It binds only the
`bitbucket-datacenter` credential, so the hub deploys it once the instance is
connected (`POST /api/integrations/workflow-deploy` answers 409
`source_not_connected` before that); a workspace with GitHub as well runs both.
Disconnecting releases the deployment and leaves the Bitbucket repository records disabled and disconnected, so the open pull request listing carries on with the other hosts. The webhook credential names this
workflow, and every mail carries `repoSource: "bitbucket-datacenter"`.

Triage with every rule switched off starts no run and writes nothing to the
pull request (`triage_skipped_no_rules` in the hub log), on either host.

## Token

An HTTP access token, sent as `Authorization: Bearer`. It needs:

| Permission | For |
| --- | --- |
| Project read | Listing projects and repositories |
| Repository write | What triage does on pull requests |
| Repository admin | Creating and removing the webhook. Without it, set the webhook up by hand (below). |

## Routes

All answer errors as `{ "error": { "code", "message" } }`.

### `PUT /connection`

Needs `manage` on the workspace, and stock `credential:*` and `provider:*`
grants for the writes.

Body: `{ "baseUrl": "https://bitbucket.example.com", "token": "..." }`.

`baseUrl` may name a private-network or localhost host, since Data Center
commonly lives on a private network. Link-local hosts (`169.254.0.0/16`),
`fd00::/8` addresses and `metadata.google.internal` are refused: a cloud
runtime answers its own metadata there, and the hub's token check would reach
it.

The token is tried once against `GET /rest/api/1.0/application-properties`
and stored only if the instance signs it in. A webhook secret is generated
unless one exists; an existing one is kept so webhooks already on the instance
keep verifying. The token is never returned.

| Status | Body |
| --- | --- |
| 200 | `{ "baseUrl", "hookUrl", "hookSecretSet": true }` |
| 400 | `invalid_request`, `bitbucket_datacenter_token_invalid`, `not_bitbucket_datacenter` |
| 409 | `bitbucket_datacenter_connected_elsewhere`: connected to another instance with repositories recorded. Disconnect first. |
| 502 | `bitbucket_datacenter_failed`, `bitbucket_datacenter_unreachable` |

### `GET /connection`

Any member. 200 `{ "baseUrl", "hookUrl" }`, or 404 `bitbucket_datacenter_not_connected`.

### `DELETE /connection`

Needs `manage` on the workspace. Removes the webhooks triage created, both
credentials and `bitbucket-datacenter`, and disables every Bitbucket repository (their
records and settings stay).

200 `{ "webhooksLeft": ["PROJECT/slug"] }`: repositories whose webhook could not
be removed and must be deleted on the instance. 404 when not connected.

### `GET /repositories`

Needs `use` on the `bitbucket-datacenter` credential. Every repository the token sees
(`GET /rest/api/1.0/repos`, all pages), merged with the stored records:

```json
{ "repositories": [{ "name": "TRI/widgets", "connected": true, "source": "bitbucket-datacenter", "enabled": false, "checks": { "ci": true, "conflicts": true }, "approvedAuthors": [] }] }
```

A recorded repository the token no longer sees is listed with
`connected: false`. 409 `bitbucket_datacenter_not_connected`, 502 on instance failure.

### `POST /repositories/{project}/{slug}/enable`

Needs `manage` on the workspace and `use` on both credentials. Records the
repository enabled with its default branch and creates its webhook, or keeps
the one it created before. Enabling a repository switches on Comment and Labels;
every other action stays off until you switch it on. Turning triage off
and on again switches Comment and Labels back on.

| Status | Body |
| --- | --- |
| 200 | `{ "repository", "webhook": "created", "hookUrl" }` |
| 200 | `{ "repository", "webhook": "manual", "hookUrl", "hookSecret", "events" }` when the token may not manage webhooks |
| 404 | `repo_not_found` |
| 409 | `bitbucket_datacenter_not_connected`, `repo_empty` (no default branch), `repo_name_taken` (a GitHub repository has the same name) |
| 502 | `bitbucket_datacenter_failed`, `bitbucket_datacenter_unreachable` |

### `GET /repositories/{project}/{slug}/webhook`

Needs `manage` on the workspace and `use` on the `bitbucket-datacenter-hook`
credential. 200 `{ "webhook": "registered", "webhookId" }` when triage created
the webhook, otherwise `{ "webhook": "manual", "hookUrl", "hookSecret", "events" }`.
Answered with `Cache-Control: no-store`, as is enable's `manual` answer.

| Status | Body |
| --- | --- |
| 403 | `forbidden` (no `manage`, or no `use` on the hook credential) |
| 404 | `repo_not_found` (no such repository recorded) |
| 409 | `bitbucket_datacenter_not_connected`, `triage_off` |

### `POST /repositories/{project}/{slug}/disable`

Needs `manage` on the workspace, and `use` on the `bitbucket-datacenter`
credential to remove the webhook triage created. Disables the repository and
removes the webhook. 200 `{ "repository", "webhookLeft" }`; `webhookLeft` is
true when the webhook could not be removed, including when the caller lacks
`use` on the credential. 404 when no such repository is recorded.

## Webhook

URL: `POST {hub}/api/hooks/bitbucket-datacenter/{tenantId}`, signed with the
`bitbucket-datacenter-hook` secret. Events:

- Pull request: `pr:opened`, `pr:modified`, `pr:from_ref_updated`,
  `pr:reviewer:approved`, `pr:reviewer:unapproved`, `pr:reviewer:needs_work`,
  `pr:comment:added`, `pr:merged`, `pr:declined`, `pr:deleted`
- Repository: `repo:refs_changed`

Data Center sends no webhook when a build status finishes, so a verdict left
waiting on `ci-green`, or failed by it, would never catch up on its own. The hub
re-reads the build statuses of such heads on the unconfirmed retry interval
(5 minutes, doubling, up to the retry cap) and queues the head again once they
changed: no longer pending, or no longer failing (`triage_requeued` with
`reason: build_status_changed`). GitHub needs none of this: its `check_run`
webhook triages the head again.

A webhook triage created is removed when the repository is disabled or the
instance disconnected; one set up by hand is not, and stays until a repository
admin deletes it.

### Setting it up by hand

When enable answers `"webhook": "manual"`, a repository admin on the instance:

1. Opens the repository, then **Repository settings → Webhooks → Create webhook**.
2. Names it `Corbits Triage` and pastes `hookUrl` as the URL.
3. Pastes `hookSecret` as the secret.
4. Selects the events above and leaves the webhook active.
5. Saves.

The hub never learns of a hand-made webhook, so the repository panel keeps the
URL, secret and events available while triage is on, collapsed under Webhook
setup except right after triage is turned on there.
