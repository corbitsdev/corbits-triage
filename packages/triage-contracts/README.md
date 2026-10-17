# @corbits/triage-contracts

Shared types and parsers for Corbits Triage.

## Policy

A policy sets which rules run on a repository's pull requests and what happens after. Its rules are stored under `checks` (built-in) and `custom`. `GET /api/integrations/pack-schema` returns its JSON Schema as `checkPack`, a workspace policy's as `sharedPolicy`, a repository policy that extends one as `policyOverride`, the repository settings as `repoPolicy`, and `.corbits-triage.yaml` as `policyFile`: schema 3, a list of `rules` (each `text`, `check`, `reason` and `evidence`), `actions` (`on` and steps per verdict) and `labels`, which `readPolicyFile` maps onto the stored shape. A file without `rules` is read as a policy or override without `kind`, `schemaVersion` and `repo`. Constraints the schema cannot state are checked when the policy is read: a custom rule's `options` and `failOn` must not repeat and `failOn` must be among `options`, a score's `failBelow` must be one of its levels after the first, and a custom id must not be a built-in rule's or read as a judge question's. A rule that fails any of these rejects the policy with its reason. Custom rules are decision-model questions (`kind: "model"`): `is-true`, `score` or `choose`, or text rules (`kind: "text"`) that fail when any of `fields` (`title`, `description`, `commits`) contains one of `phrases`, or with `failWhen: "not-contains"` when one contains none, ignoring case; a stored rule of the retired `kind: "rule"` rejects the policy. The reader ignores unknown built-in rows. Built-in rule ids renamed earlier (`size`, `issue`, `conflicts`, `ci`, `paths`, `draft`, `review`) are still read and mapped to their new ids by `RENAMED_RULE_IDS`; an old `size` row loads as both size limits. A new custom rule's id is its name as lowercase words joined by hyphens, numbered past any taken id; it never starts with `docs-` or `focused-` or ends in `-file`, `-hunk` or `-slice` and numbers, as judge question ids do.

`actions` holds one `when` (the events it wakes on) and an ordered list of steps per verdict. Each step is `{ do, target?, when? }`; its `when` holds conditions that must all hold for it to run (`whenHolds`): `author` (any of GitHub's `author_association` values `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`, or `BOT` for a bot whatever its association, `{ team }`, `{ users }`; a stored or file policy naming a group of `AUTHOR_GROUPS`, `maintainers`, `external`, `first-timers` or `bots`, reads it as exactly that group's kinds), `linkedIssue`, `ci` (any of `passing`, `failing`, `pending`, `none`), and `files` and `lines` as `{ over?, atMost? }`. A stored step's `for` reads as `when: { author: [<for>] }`, and `for: anyone` as no condition. Every rule row may carry `text`, `reason` and `evidence` (`#44`, `owner/name#44`, https links or `maintainer-stated`). An action runs on its own only when the workspace's `pr-triage` system role holds `invoke` on `triage-do:<kind>:<owner>/<name>`; otherwise it waits for a person holding that grant, and `close` on `unsure` and `merge` on anything but `pass` always wait. `labels` names the label the mirror writes for each verdict; a verdict it leaves out keeps its default (`Triage: Ready`, `Triage: Not Ready`, `Triage: Needs Human Review`). The published schema validates `schemaVersion` 2. A version 1 policy still reads, as version 2: its actions become steps for anyone, and actions that no longer run, custom rules over GitHub data and text longer than version 2 allows are left out or cut and named in `dropped`; the next save writes version 2. Repository roles were removed, so a step whose target is a role is left out and named in the pack's `dropped`.

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
    { "id": "care", "name": "Care", "group": "pull-request", "kind": "model", "shape": "score", "subject": "how carefully the change is made", "levels": ["poor", "fair", "good", "great"], "failBelow": "fair" },
    { "id": "no-attribution-trailers", "name": "No attribution trailers", "group": "pull-request", "kind": "text", "fields": ["description", "commits"], "failWhen": "contains", "phrases": ["Co-Authored-By:", "Generated with", "Claude-Session:"] }
  ],
  "actions": {
    "when": ["opened", "updated", "checks", "ready"],
    "pass": [{ "do": "approve" }, { "do": "merge", "when": { "author": ["OWNER", "MEMBER", "COLLABORATOR"], "ci": ["passing"] } }],
    "fail": [{ "do": "request-changes" }, { "do": "labels", "target": { "from": "rules" } }],
    "unsure": [{ "do": "request-review", "target": { "to": "teams", "teams": ["acme/core"] } }]
  },
  "labels": {
    "pass": "Ready to ship"
  }
}
```

Store the policy as a text artifact through the tenant artifact routes the hub mounts from `@corbits/artifacts`: `POST /api/tenants/{tenantId}/artifacts` with `{ "mode": "text", "title": "check-pack/<owner>/<name>", "content": "<policy JSON>" }` creates it, and `POST /api/tenants/{tenantId}/artifacts/{id}/versions` with `title`, `content` and `expectedVersion` replaces it. The repository's record pins the artifact as `checkPack: { name, id }`, which the portal writes on save; until then the hub reads the newest artifact with that title.

A workspace policy is the same shape without `repo`, titled `workspace-policy/<name>`. A repository policy that sets `extends` to its artifact id holds only what it overrides; `resolvePolicy` merges built-in rules field by field, custom rules by id, and `when`, each verdict's steps and each verdict's label by what the repository sets. The hub mails the resolved pack and names the artifact versions it came from as `policy.source: { repo: { id, version }, shared?: { id, version } }`.
