# @corbits/triage-contracts

Shared types and parsers for Corbits Triage.

## Policy

A policy sets which rules run on a repository's pull requests and what happens after. `GET /api/integrations/pack-schema` returns its JSON Schema as `checkPack`, beside the repository settings as `repoPolicy`. Constraints the schema cannot state are checked when the policy is read: a rule reference must name a built-in rule or a custom rule in the policy, and an action with rules uses `yes`/`no`/`unsure` and one without uses `always`. A Do runs on its own only when the workspace's `pr-triage` system role holds `invoke` on `triage-do:<kind>:<owner>/<name>`; otherwise it waits for a person holding that grant, and `close` under `unsure`, and `close` and `agent` under `always`, always wait. The reader ignores a legacy `automatic` flag. A custom rule is a `rule` evaluated over GitHub data or a decision-model question (`model`). The reader also requires its patterns to compile as regular expressions without flags, its `options` and `failOn` not to repeat, and a `choose` row's `failOn` to be among its `options`; a custom rule that fails any of these rejects the policy with its reason. A legacy row without `kind` asks its `instruction` as an `is-true` claim. The reader ignores unknown built-in rows and blank legacy rows rather than rejecting the policy. Built-in rule ids renamed earlier (`size`, `issue`, `conflicts`, `ci`, `paths`, `draft`, `review`) are still read and mapped to their new ids by `RENAMED_RULE_IDS`; an old `size` row loads as both size limits. Stored `custom-N` ids stay as they are. A new custom rule's id is its name as lowercase words joined by hyphens, numbered past any taken id; it never starts with `docs-` or `focused-` or ends in `-file`, `-hunk` or `-slice` and numbers, as judge question ids do.

```json
{
  "kind": "corbits.triage.check-pack",
  "schemaVersion": 1,
  "repo": "acme/widgets",
  "checks": {
    "ci-green": { "enabled": true },
    "max-files-changed": { "enabled": true, "maxFiles": 30 },
    "max-lines-changed": { "enabled": true, "maxLines": 3000 }
  },
  "custom": [
    { "id": "ticket", "name": "Ticket", "group": "pull-request", "kind": "model", "shape": "is-true", "claim": "The title mentions a ticket id." }
  ],
  "actions": [
    {
      "id": "review-ready",
      "when": ["opened", "ready"],
      "checks": ["ci-green", "ticket"],
      "branches": {
        "yes": [{ "kind": "request-review", "target": { "to": "role", "role": "maintainers" } }],
        "no": [{ "kind": "comment", "target": { "body": "Please fix CI and link a ticket." } }],
        "unsure": [{ "kind": "labels", "target": { "from": "list", "labels": ["needs-triage"] } }]
      }
    },
    {
      "id": "label-type",
      "when": "every",
      "checks": [],
      "branches": { "always": [{ "kind": "labels", "target": { "from": "type" } }] }
    }
  ]
}
```

The `maintainers` role is defined in the repository settings' `roles`, for example `{ "maintainers": { "teams": ["core"] } }`.

Store the policy as a text artifact through the tenant artifact routes the hub mounts from `@corbits/artifacts`: `POST /api/tenants/{tenantId}/artifacts` with `{ "mode": "text", "title": "check-pack/<owner>/<name>", "content": "<policy JSON>" }` creates it, and `POST /api/tenants/{tenantId}/artifacts/{id}/versions` with `title`, `content` and `expectedVersion` replaces it.
