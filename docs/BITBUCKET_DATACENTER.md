# Bitbucket Data Center

How a workspace connects one Bitbucket Data Center instance and turns triage on
for its repositories. Every step is a hub route under
`/api/integrations/bitbucket-datacenter/{tenantId}`, listed in `/openapi.json`; the portal
is a wrapper over them.

## What is stored where

- The instance URL is `bitbucketDatacenter.baseUrl` in the workspace's `corbitsTriage`
  config, with `bitbucketDatacenter.user`, the slug the token acts as, whose
  own webhook events never wake triage. One connection per workspace. Only the
  connect route writes it, and each read checks the URL again as connect does;
  one that fails reads as not connected, and disconnect still removes it.
- The token is the stock credential `bitbucket-datacenter` (type `api_key`) on the stock
  provider `bitbucket-datacenter` (plugin `http`, `apiBaseUrl` = the instance URL).
- The webhook secret is the stock credential `bitbucket-datacenter-hook`, with
  `metadata.webhook` `{ verify: "x-hub-signature", workflow, headers }`, the
  headers being Data Center's (see [Webhook](#webhook)).
- Repositories are records in `corbitsTriage.repos` with `source: "bitbucket-datacenter"`,
  named `PROJECTKEY/slug` (for example `TRI/widgets`), with `defaultBranch` and,
  when triage created the webhook, `webhookId`.

## Workflow

Bitbucket repositories are triaged by the `triage-listener-bitbucket-datacenter`
listener and the managers it deploys, the same steps as on GitHub built over the
Bitbucket tools. They bind only the `bitbucket-datacenter` credential, so
the hub starts them once the instance is connected and the workspace has a
decision model; a workspace with GitHub as well runs both hosts' listeners.
Disconnecting releases the host's listener and its managers and leaves the Bitbucket repository records disabled and disconnected, so the open pull request listing carries on with the other hosts. The webhook credential names this
listener, and every mail carries `repoSource: "bitbucket-datacenter"`.

Triage with every rule switched off starts no run and writes nothing to the
pull request (`triage_skipped_no_rules` in the hub log), on either host.

## Token

An HTTP access token, sent as `Authorization: Bearer`. A fresh Data Center 10.5 instance turns off password Basic auth for the REST API, so a token is the only way in. It needs:

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

The hub resolves `baseUrl` once each time it is about to send the token (at
connect, for each portal request, for each hub-side read, and before it
spawns a Bitbucket workflow run) and connects to the address it checked,
with the hostname as `Host` and TLS server name, so a second DNS answer
cannot redirect the request. Every address must be public unicast: anything
else (loopback, private, link-local, carrier-grade NAT, reserved,
multicast, NAT64, 6to4, IPv4-compatible or site-local IPv6) is refused, as
are a failed or empty lookup and the hostnames `metadata` and
`metadata.google.internal`. A host listed in `BITBUCKET_EGRESS_ALLOWLIST`
(a hub environment variable, not a tenant setting) may also resolve to
private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` other
than `fd00:ec2::254`) or loopback addresses; nothing else can be listed.
`GET /connection` reads the stored URL without resolving it; a stored host
that is refused answers `bitbucket_datacenter_host_refused` where the token
would be sent. A workflow run's sidecar resolves the host again itself, so
deny sidecar egress to metadata addresses at the network layer
([SELF_HOST.md](SELF_HOST.md)).

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
{ "repositories": [{ "name": "TRI/widgets", "connected": true, "source": "bitbucket-datacenter", "enabled": true, "defaultBranch": "main", "webhookId": 12 }] }
```

A recorded repository the token no longer sees is listed with
`connected: false`. 409 `bitbucket_datacenter_not_connected` or `bitbucket_datacenter_host_refused`, 502 on instance failure.

### `POST /repositories/{project}/{slug}/enable`

Needs `manage` on the workspace and `use` on both credentials. Records the
repository enabled with its default branch and creates its webhook, or keeps
the one it created before. Enabling a repository switches on Comment, which
also writes the verdict as the `Corbits Triage` build status, since the host
has no labels; every other action stays off until you switch it on. Turning
triage off and on again switches Comment back on. At each start the hub
removes Labels and Assign grants left on Bitbucket repositories.

| Status | Body |
| --- | --- |
| 200 | `{ "repository", "webhook": "created", "hookUrl" }` |
| 200 | `{ "repository", "webhook": "manual", "hookUrl", "hookSecret", "events" }` when the token may not manage webhooks |
| 404 | `repo_not_found` |
| 409 | `bitbucket_datacenter_not_connected`, `bitbucket_datacenter_host_refused`, `repo_empty` (no default branch), `repo_name_taken` (a GitHub repository has the same name) |
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
`bitbucket-datacenter-hook` secret. Data Center signs as GitHub does, `sha256=`
and the hex HMAC of the raw body, in `X-Hub-Signature`, with the event in
`X-Event-Key` and the delivery id in `X-Request-Id`; the hook credential's
`metadata.webhook.headers` names these three. Events:

- Pull request: `pr:opened`, `pr:modified`, `pr:from_ref_updated`,
  `pr:reviewer:approved`, `pr:reviewer:unapproved`, `pr:reviewer:needs_work`,
  `pr:comment:added`, `pr:merged`, `pr:declined`, `pr:deleted`
- Repository: `repo:refs_changed`

Data Center sends no webhook when a build finishes, so the reconciler polls.
A head waiting for CI is released by the pass that finds its build statuses no
longer in progress, up to one reconcile interval after its builds end. While
it waits, its `Corbits Triage` build status reads `INPROGRESS` "Triage:
Waiting for CI" where Comment is on; the hub's own CI read leaves that status
out. A verdict left unsure or failed by `ci-green` is re-read on the
unconfirmed retry interval (5 minutes, doubling) and queued again once its
builds changed (`triage_requeued` with `reason: build_status_changed`).

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
