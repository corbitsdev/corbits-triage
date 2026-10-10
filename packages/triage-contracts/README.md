# @corbits/triage-contracts

Shared types and parsers for Corbits Triage.

## Check pack

A check pack sets which checks run on a repository's pull requests and what happens after. `GET /api/integrations/pack-schema` returns its JSON Schema as `checkPack`, beside `repoPolicy`. Rules the schema cannot state are checked when the pack is read: a check reference must name a catalog check or a custom check in the pack, an action with checks uses `yes`/`no`/`unsure` and one without uses `always`, and a step that is not `automatic` waits for a maintainer, which `close` must under `unsure` and `close` and `agent` must under `always`. The reader ignores catalog and custom rows it cannot read rather than rejecting the pack.

```json
{
  "kind": "corbits.triage.check-pack",
  "schemaVersion": 1,
  "repo": "acme/widgets",
  "checks": {
    "ci": { "enabled": true },
    "size": { "enabled": true, "maxFiles": 20, "maxLines": 500 }
  },
  "custom": [
    { "id": "custom-1", "name": "Ticket", "group": "pull-request", "instruction": "The title mentions a ticket id." }
  ],
  "actions": [
    {
      "id": "review-ready",
      "when": ["opened", "ready"],
      "checks": ["ci", "custom-1"],
      "branches": {
        "yes": [{ "kind": "request-review", "automatic": true, "target": { "to": "role", "role": "maintainers" } }],
        "no": [{ "kind": "comment", "automatic": false, "target": { "body": "Please fix CI and link a ticket." } }],
        "unsure": [{ "kind": "labels", "automatic": true, "target": { "from": "list", "labels": ["needs-triage"] } }]
      }
    },
    {
      "id": "label-type",
      "when": "every",
      "checks": [],
      "branches": { "always": [{ "kind": "labels", "automatic": true, "target": { "from": "type" } }] }
    }
  ]
}
```

The `maintainers` role is defined in the repository policy's `roles`, for example `{ "maintainers": { "teams": ["core"] } }`.

Store the pack as a text artifact through the tenant artifact routes the hub mounts from `@corbits/artifacts`: `POST /api/tenants/{tenantId}/artifacts` with `{ "mode": "text", "title": "check-pack/<owner>/<name>", "content": "<pack JSON>" }` creates it, and `POST /api/tenants/{tenantId}/artifacts/{id}/versions` with `title`, `content` and `expectedVersion` replaces it.
