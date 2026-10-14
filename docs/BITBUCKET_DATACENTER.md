# Bitbucket Data Center

How a workspace connects one Bitbucket Data Center instance and turns triage on
for its repositories. Every step is a hub route under
`/api/integrations/bitbucket-datacenter/{tenantId}`, listed in `/openapi.json`; the portal
is a wrapper over them.

## What is stored where

- The instance URL is `bitbucketDatacenter.baseUrl` in the workspace's `corbitsTriage`
  config. One connection per workspace.
- The token is the stock credential `bitbucket-datacenter` (type `api_key`) on the stock
  provider `bitbucket-datacenter` (plugin `http`, `apiBaseUrl` = the instance URL).
- The webhook secret is the stock credential `bitbucket-datacenter-hook`, with
  `metadata.webhook` as the GitHub hook credential has it.
- Repositories are records in `corbitsTriage.repos` with `source: "bitbucket-datacenter"`,
  named `PROJECTKEY/slug` (for example `TRI/widgets`), with `defaultBranch` and,
  when triage created the webhook, `webhookId`.

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
the one it created before.

| Status | Body |
| --- | --- |
| 200 | `{ "repository", "webhook": "created", "hookUrl" }` |
| 200 | `{ "repository", "webhook": "manual", "hookUrl", "hookSecret", "events" }` when the token may not manage webhooks |
| 404 | `repo_not_found` |
| 409 | `bitbucket_datacenter_not_connected`, `repo_empty` (no default branch), `repo_name_taken` (a GitHub repository has the same name) |
| 502 | `bitbucket_datacenter_failed`, `bitbucket_datacenter_unreachable` |

### `POST /repositories/{project}/{slug}/disable`

Needs `manage` on the workspace. Disables the repository and removes the
webhook triage created. 200 `{ "repository", "webhookLeft" }`; `webhookLeft`
is true when it could not be removed. 404 when no such repository is recorded.

## Webhook

URL: `POST {hub}/api/hooks/bitbucket-datacenter/{tenantId}`, signed with the
`bitbucket-datacenter-hook` secret. Events:

- Pull request: `pr:opened`, `pr:modified`, `pr:from_ref_updated`,
  `pr:reviewer:approved`, `pr:reviewer:unapproved`, `pr:reviewer:needs_work`,
  `pr:comment:added`, `pr:merged`, `pr:declined`, `pr:deleted`
- Repository: `repo:refs_changed`

### Setting it up by hand

When enable answers `"webhook": "manual"`, a repository admin on the instance:

1. Opens the repository, then **Repository settings → Webhooks → Create webhook**.
2. Names it `Corbits Triage` and pastes `hookUrl` as the URL.
3. Pastes `hookSecret` as the secret.
4. Selects the events above and leaves the webhook active.
5. Saves.
