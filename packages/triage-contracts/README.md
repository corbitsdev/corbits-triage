# @corbits/triage-contracts

Shared types and parsers for Corbits Triage: the policy, the policy file, repository settings, triage state, labels
and trigger mail. Every app and most packages import it.

## Use

`@corbits/triage-contracts` exports everything; `/code-review`, `/paths` and `/team` are subpath exports.

### Policy

A policy sets which rules run on a repository's pull requests and what happens after. Its rules are stored under `checks` (built-in) and `custom`. `GET /api/integrations/pack-schema` returns its JSON Schema as `checkPack`, a workspace policy's as `sharedPolicy`, a repository policy that extends one as `policyOverride`, the repository settings as `repoPolicy`, and `.corbits-triage.yml` as `policyFile`: schema 3, a list of `rules` (each `text`, `check`, `reason` and `evidence`), `actions` (`on` and steps per verdict) and `labels`, which `readPolicyFile` maps onto the stored shape; `checkPolicyFile` answers the same or each problem with its line, and the file's v4 keys as `workflow`. Those keys (`policy-workflow.ts`) are `groups` (each `association`, `teams` or `users`), one key per block (`code-review`, `security`, `deslop`; each `on`, and optionally `for`, `when: { triage, paths }`, `clean: { below }` and `provider`), `pace`, `pauseLabel` and `decide` (rules `{ if, do }`, `if` on `all`, `triage`, `event`, `author` and each block's outcome); they are validated and returned as written, and nothing acts on them yet except steps naming a group and, on GitHub, `pauseLabel`, whose label on a pull request stops the hub starting runs for it. A file that sets `extends` holds none of them. Groups are matched first match wins, in the file's order: an author is in at most one of the file's groups, then in each built-in group (`maintainers`, `external`, `first-timers`, `bots`) their author kind puts them in, which are facts matched independently, then in `everyone`, which always matches; a file group with a built-in group's name replaces it. `authorGroupsOf(groups, author)` answers that set, failing closed: it answers none, so no `{ group }` but `everyone` holds, when the author's kind is not known or teams that can't be read would decide their file group. A step's built-in group reads as author kinds, so it still holds when teams can't be read, and is not known only when the author's kind is. The teams read for an author are every team the policy names, in a step or a group (`policyTeams`). A step's `when.author` names groups as the policy holds them, `{ group }` for a file group or `everyone` and a built-in group's kinds otherwise, and holds when the author's set includes it; approving or merging must never rest on `everyone` alone. `{ all: clean }` holds when at least one block ran and every block that ran is clean; skipped blocks never count, so it fails when every block was skipped or none is on. A rule that approves or merges without `triage` matches only Pass (`ruleVerdicts`). Incomplete is never clean: a rule that approves or merges can't name `incomplete`, and `decide` itself only matches such a rule when nothing that ran is incomplete. A file that sets `actions` and no `decide` gets its `decide` from `decideOf`: one rule `{ if: { triage: <verdict> }, do: <its steps> }` per verdict with steps, `do: nothing` for a Pass or Fail with none, and no rule for an Unsure with none, each limited to `event: <actions.on>` when the actions wake on fewer than every event; with a block on, a verdict whose steps approve or merge gets two rules, all its steps under `all: clean` and then the same steps with approve and merge as `nothing`, each in its place; a file that extends another has no `decide`. A `decide` rule can't use `review` yet. `decide(rules, input)` evaluates the rules for one run: the first matching rule's `do`, or a flag for a maintainer when nothing matches, when a rule names groups and the author's can't be read, or when the match approves or merges after an incomplete block; a block that is on, or that a rule names, with no outcome reads as incomplete. A file setting any v4 key is read as schema 3 and needs `rules`. Problems name their line from the YAML parser's node positions (`yaml`, core schema, aliases and the keys `__proto__`, `constructor` and `prototype` refused); schema errors are said in the file's terms by `policy-file-problems.ts`. A file without `rules` or a v4 key is read as a policy or override without `kind`, `schemaVersion` and `repo`. Constraints the schema cannot state are checked when the policy is read: a custom rule's `options` and `failOn` must not repeat and `failOn` must be among `options`, a score's `failBelow` must be one of its levels after the first, and a custom id must not be a built-in rule's or read as a judge question's. A rule that fails any of these rejects the policy with its reason. Custom rules are decision-model questions (`kind: "model"`): `is-true`, `score` or `choose`, or text rules (`kind: "text"`) that fail when any of `fields` (`title`, `description`, `commits`) contains one of `phrases`, or with `failWhen: "not-contains"` when one contains none, ignoring case; a stored rule of the retired `kind: "rule"` rejects the policy. The reader ignores unknown built-in rows. Built-in rule ids renamed earlier (`size`, `issue`, `conflicts`, `ci`, `paths`, `draft`, `review`) are still read and mapped to their new ids by `RENAMED_RULE_IDS`; an old `size` row loads as both size limits. A new custom rule's id is its name as lowercase words joined by hyphens, numbered past any taken id; it never starts with `docs-` or `focused-` or ends in `-file`, `-hunk` or `-slice` and numbers, as judge question ids do.

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

Store the policy as a text artifact through the tenant artifact routes the hub mounts from `@corbits/artifacts`: `POST /api/tenants/{tenantId}/artifacts` with `{ "mode": "text", "title": "check-pack/<owner>/<name>", "content": "<policy JSON>" }` creates it (`check-pack/bitbucket-datacenter/<owner>/<name>` for a Bitbucket Data Center repository, as `checkPackName(repo, source)` names it), and `POST /api/tenants/{tenantId}/artifacts/{id}/versions` with `title`, `content` and `expectedVersion` replaces it. The repository's record pins the artifact as `checkPack: { name, id }`, which the portal writes on save; until then the hub reads a GitHub repository's newest artifact with that title. The trigger mail names the title for the repository's host as `policy.checkPack.name`.

A workspace policy is the same shape without `repo`, titled `workspace-policy/<name>`. A repository policy that sets `extends` to its artifact id holds only what it overrides; `resolvePolicy` merges built-in rules field by field, custom rules by id, and `when`, each verdict's steps and each verdict's label by what the repository sets. A policy file may instead set `extends` to another repository (`owner/name`); `extendedFilePack` resolves it the same way over that repository's file, which must not extend another. The hub mails the resolved pack and names what it came from as `policy.source: { repo?: { id, version }, shared?: { id, version }, file?: { path, sha }, sharedFile?: { repo, path, sha } }`.

## Test

```sh
bun --conditions=intx-src test packages/triage-contracts
```

## Docs

- [PRODUCT.md](../../docs/PRODUCT.md#policy-file)
- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
