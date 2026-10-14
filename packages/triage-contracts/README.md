# @corbits/triage-contracts

Shared types and parsers for Corbits Triage.

## Policy

A policy sets which rules run on a repository's pull requests and what happens after. Its rules are stored under `checks` (built-in) and `custom`. `GET /api/integrations/pack-schema` returns its JSON Schema as `checkPack`, beside the repository settings as `repoPolicy`. Constraints the schema cannot state are checked when the policy is read: a custom rule's `options` and `failOn` must not repeat and `failOn` must be among `options`, a score's `failBelow` must be one of its levels after the first, and a custom id must not be a built-in rule's or read as a judge question's. A rule that fails any of these rejects the policy with its reason. Custom rules are decision-model questions (`kind: "model"`): `is-true`, `score` or `choose`; a stored rule over GitHub data (`kind: "rule"`) rejects the policy. The reader ignores unknown built-in rows. Built-in rule ids renamed earlier (`size`, `issue`, `conflicts`, `ci`, `paths`, `draft`, `review`) are still read and mapped to their new ids by `RENAMED_RULE_IDS`; an old `size` row loads as both size limits. A new custom rule's id is its name as lowercase words joined by hyphens, numbered past any taken id; it never starts with `docs-` or `focused-` or ends in `-file`, `-hunk` or `-slice` and numbers, as judge question ids do.

`actions` holds one `when` and an ordered list of steps per verdict. Each step is `{ do, target?, for? }`; `for` is who opened the pull request (`anyone` when left out). A Do runs on its own only when the workspace's `pr-triage` system role holds `invoke` on `triage-do:<kind>:<owner>/<name>`; otherwise it waits for a person holding that grant, and `close` on `unsure` and `merge` on anything but `pass` always wait. `labels` names the label the mirror writes for each verdict; a verdict it leaves out keeps its default (`Triage: Ready`, `Triage: Not Ready`, `Triage: Needs Human Review`). The published schema validates `schemaVersion` 2. A version 1 policy still reads, as version 2: its Dos become steps for anyone, and Dos that no longer run, custom rules over GitHub data and text longer than version 2 allows are left out or cut and named in `dropped`; the next save writes version 2. Repository roles were removed, so a step whose target is a role is left out and named in the pack's `dropped`.

```json
{
  "kind": "corbits.triage.check-pack",
  "schemaVersion": 2,
  "repo": "acme/widgets",
  "checks": {
    "ci-green": { "enabled": true },
    "max-files-changed": { "enabled": true, "maxFiles": 30 },
    "max-lines-changed": { "enabled": true, "maxLines": 3000 }
  },
  "custom": [
    { "id": "ticket", "name": "Ticket", "group": "pull-request", "kind": "model", "shape": "is-true", "claim": "The title mentions a ticket id." },
    { "id": "care", "name": "Care", "group": "pull-request", "kind": "model", "shape": "score", "subject": "how carefully the change is made", "levels": ["poor", "fair", "good", "great"], "failBelow": "fair" }
  ],
  "actions": {
    "when": ["opened", "updated", "checks", "ready"],
    "pass": [{ "do": "approve" }, { "do": "merge", "for": "maintainers" }],
    "fail": [{ "do": "request-changes" }, { "do": "labels", "target": { "from": "rules" } }],
    "unsure": [{ "do": "request-review", "target": { "to": "teams", "teams": ["acme/core"] } }]
  },
  "labels": {
    "pass": "Ready to ship"
  }
}
```

Store the policy as a text artifact through the tenant artifact routes the hub mounts from `@corbits/artifacts`: `POST /api/tenants/{tenantId}/artifacts` with `{ "mode": "text", "title": "check-pack/<owner>/<name>", "content": "<policy JSON>" }` creates it, and `POST /api/tenants/{tenantId}/artifacts/{id}/versions` with `title`, `content` and `expectedVersion` replaces it.
