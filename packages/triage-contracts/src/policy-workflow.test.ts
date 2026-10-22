import { describe, expect, test } from "bun:test";
import type { Type } from "arktype";
import { readCheckPack } from "./check-pack.ts";
import { exportPolicyFile, policyDifferences } from "./policy-export.ts";
import { checkPolicyFile, readPolicyFile } from "./policy-file.ts";
import { policyWorkflowSchema } from "./policy-workflow.ts";
import { authorGroupsOf, whenHolds, type StepAuthor } from "./step-when.ts";

const REPO = "acme/widgets";
const RULES = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n";
const ON = "code-review: { on: true }\nsecurity: { on: true }\n";
const KINDS = "`approve`, `merge`, `close`, `request-changes`, `review`, `nothing`, `comment`, `request-review`, `assign` or `labels`";
const STEP_KINDS = "`approve`, `merge`, `close`, `comment`, `request-changes`, `request-review`, `assign`, `labels` or `nothing`";
const DURATION = "a duration of at least 1, such as 30s, 2m, 24h or 7d";

const V4 = `${RULES}groups:
  maintainers: { association: [OWNER, MEMBER, COLLABORATOR] }
  core: { teams: [acme/core], users: [octocat] }
code-review: { on: true, for: [maintainers], provider: anthropic, when: { triage: pass, paths: ["!**/*.md", "!**/*.lock"] } }
security:
  on: true
  when: { triage: [pass, unsure], paths: ["src/**"] }
  clean: { below: medium }
deslop: { on: false, provider: openai }
pace: { debounce: 30s, maxWait: 2m, perHead: 1, cap: { runs: 5, per: 24h }, backoff: { pushes: 5, within: 10m, pause: 30m } }
pauseLabel: "corbits: pause"
decide:
  - { if: { triage: fail, event: [opened] }, do: [request-changes, { do: comment, target: { body: Fix the rules. }, when: { author: [core] } }] }
  - { if: { all: clean }, do: approve }
  - { if: { author: [core], code-review: clean, security: [clean, skipped] }, do: merge }
  - { if: { security: { findings: high } }, do: [{ do: request-review, target: { to: codeowners } }] }
`;

function problems(text: string) {
  const checked = checkPolicyFile(text, REPO);
  return checked.ok ? [] : checked.problems;
}

describe("policy file v4", () => {
  test("every v4 key reads as written beside the stored policy, which holds only the rules, and a step's groups read as who they stand for", () => {
    const checked = checkPolicyFile(V4, REPO);
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    expect(checked.policy).toEqual({ ...readPolicyFile(RULES, REPO), groups: checked.workflow.groups });
    expect(checked.workflow).toEqual({
      groups: { maintainers: { association: ["OWNER", "MEMBER", "COLLABORATOR"] }, core: { teams: ["acme/core"], users: ["octocat"] } },
      "code-review": { on: true, for: ["maintainers"], provider: "anthropic", when: { triage: "pass", paths: ["!**/*.md", "!**/*.lock"] } },
      security: { on: true, when: { triage: ["pass", "unsure"], paths: ["src/**"] }, clean: { below: "medium" } },
      deslop: { on: false, provider: "openai" },
      pace: { debounce: "30s", maxWait: "2m", perHead: 1, cap: { runs: 5, per: "24h" }, backoff: { pushes: 5, within: "10m", pause: "30m" } },
      pauseLabel: "corbits: pause",
      decide: [
        { if: { triage: "fail", event: ["opened"] }, do: ["request-changes", { do: "comment", target: { body: "Fix the rules." }, when: { author: [{ group: "core" }] } }] },
        { if: { all: "clean" }, do: "approve" },
        { if: { author: ["core"], "code-review": "clean", security: ["clean", "skipped"] }, do: "merge" },
        { if: { security: { findings: "high" } }, do: [{ do: "request-review", target: { to: "codeowners" } }] },
      ],
    });
  });

  test("a step names a file group, or everyone, as the group, and a built-in group no file group replaces as its kinds", () => {
    const file = `${RULES}groups: { maintainers: { users: [octocat] } }\nactions:\n  pass: [{ do: approve, when: { author: [maintainers, bots, everyone] } }]\n`;
    expect(readPolicyFile(file, REPO)).toMatchObject({ actions: { pass: [{ do: "approve", when: { author: [{ group: "maintainers" }, "BOT", { group: "everyone" }] } }] } });
  });

  test("schema 3 actions read as decide: one rule per verdict on the events they wake on, every step kept; an empty Pass or Fail does nothing, an empty Unsure is flagged", () => {
    const file = `${RULES}actions:\n  on: [opened, ready]\n  pass:\n    - do: approve\n      when: { author: [maintainers], ci: [passing] }\n    - do: merge\n`;
    expect(checkPolicyFile(file, REPO)).toMatchObject({
      ok: true,
      workflow: {
        decide: [
          { if: { triage: "pass", event: ["opened", "ready"] }, do: [{ do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"], ci: ["passing"] } }, { do: "merge" }] },
          { if: { triage: "fail", event: ["opened", "ready"] }, do: "nothing" },
        ],
      },
    });
    expect(checkPolicyFile("checks:\n  ci-green: { enabled: true }\nactions:\n  when: [opened, updated, checks, ready]\n  pass: []\n  fail: []\n  unsure: [{ do: close }]\n", REPO)).toMatchObject({
      ok: true,
      workflow: { decide: [{ if: { triage: "pass" }, do: "nothing" }, { if: { triage: "fail" }, do: "nothing" }, { if: { triage: "unsure" }, do: [{ do: "close" }] }] },
    });
  });

  test("schema 3 actions beside a block that is on approve and merge only when every block that ran is clean, and otherwise run the rest in their places", () => {
    const file = `${RULES}code-review: { on: true }\nactions:\n  pass: [{ do: request-review, target: { to: codeowners } }, { do: approve }, { do: merge }]\n`;
    const pass = [{ do: "request-review", target: { to: "codeowners" } }, { do: "approve" }, { do: "merge" }];
    expect(checkPolicyFile(file, REPO)).toMatchObject({
      ok: true,
      workflow: {
        decide: [
          { if: { triage: "pass", all: "clean" }, do: pass },
          { if: { triage: "pass" }, do: [pass[0], { do: "nothing" }, { do: "nothing" }] },
          { if: { triage: "fail" }, do: "nothing" },
        ],
      },
    });
  });

  test("a file that extends another holds no v4 key, and reads with no decide", () => {
    expect(checkPolicyFile(`extends: acme/shared\n${RULES}actions:\n  fail: [{ do: close }]\n`, REPO)).toEqual(expect.objectContaining({ ok: true, workflow: {} }));
    expect(problems(`extends: acme/shared\n${RULES}code-review: { on: true }\ndecide:\n  - { if: { triage: fail }, do: close }\n`)).toEqual([
      { message: "`extends` can't be used beside `code-review`, `decide`; remove `extends` or those keys.", line: 1 },
    ]);
  });

  test("a group name too long to be one is refused at once, never compared with the known names", () => {
    const name = "a".repeat(22_000);
    const started = performance.now();
    expect(problems(`${RULES}groups: { ${name}: { users: [octocat] } }\nsecurity: { on: true, for: [${name}] }\n`).map((problem) => problem.message)).toEqual([
      "`security.for` must be a list of group names, each lowercase words joined by hyphens, at most 64 characters.",
    ]);
    expect(problems(`${RULES}groups: { ${name}: { users: [octocat] } }\n`).map((problem) => problem.message)).toEqual([
      `\`groups.${"a".repeat(80)}…\` must be named in lowercase words joined by hyphens, starting with a letter, at most 64 characters.`,
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("nesting thousands deep is refused at once on its line, never walked path by path", () => {
    const started = performance.now();
    expect(problems(`${RULES}pace: ${"[".repeat(5000)}${"]".repeat(5000)}\n`)).toEqual([{ message: "The policy file nests deeper than 32 levels.", line: 6, column: 38 }]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a long invalid group name is never compared with the names that refer to it", () => {
    const name = "a".repeat(56_000);
    const references = Array.from({ length: 50 }, (_, at) => `g${at}`).join(", ");
    const started = performance.now();
    const said = problems(`${RULES}groups: { ${name}: { users: [octocat] } }\nsecurity: { on: true, for: [${references}] }\n`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(said).toHaveLength(51);
  });

  test("a key that would reach a prototype, an alias and a YAML error are each refused on their line", () => {
    expect(problems(`${RULES}groups:\n  __proto__: { users: [octocat] }\n`)).toEqual([{ message: "`__proto__` can't be a key; rename it.", line: 7, column: 3 }]);
    expect(problems(`${RULES}pace: { constructor: 1 }\n`)).toEqual([{ message: "`constructor` can't be a key; rename it.", line: 6, column: 9 }]);
    expect(problems(`${RULES}groups:\n  core: &core { users: [octocat] }\n  ops: *core\n`)).toEqual([{ message: "The policy file is too large or uses aliases.", line: 8, column: 8 }]);
    expect(problems("a: 1\na: 2\n")).toEqual([{ message: "The policy file is not YAML: Map keys must be unique.", line: 2, column: 1 }]);
  });

  test("plain scalars read as the policy file always read them, and an exported file reads back as the policy it came from", () => {
    const file = `${RULES}actions:\n  pass: [{ do: comment, target: { body: "0x10 .inf ~" } }]\n`;
    expect(readPolicyFile(file, REPO)).toMatchObject({ actions: { pass: [{ do: "comment", target: { body: "0x10 .inf ~" } }] } });
    const checked = checkPolicyFile(`${RULES}pace: { perHead: 0x10 }\npauseLabel: ~\n`, REPO);
    expect(checked).toEqual({ ok: false, problems: [{ message: "`pauseLabel` must be a label of at most 50 characters.", line: 7 }] });
    const pack = readCheckPack(readPolicyFile(`${RULES}groups: { core: { users: [octocat] } }\nactions:\n  pass: [{ do: comment, target: { body: "~" }, when: { author: [core, maintainers] } }]\nlabels: { pass: "0x10" }\n`, REPO), REPO);
    expect(readPolicyFile(exportPolicyFile(pack, false).text, REPO)).toEqual(pack);
  });

  test.each([
    [`${RULES}security: { on: true, when: { triage: maybe } }\n`, "`security.when.triage` must be pass, fail or unsure, or a list of them.", 6],
    [`${RULES}security:\n  on: true\n  when:\n    paths: [src/**]\n    triage: [pass, maybe]\n`, "`security.when.triage` must be pass, fail or unsure, or a list of them.", 10],
    [`${RULES}security: { on: true, when: { paths: [] } }\n`, "`security.when.paths` must be a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches.", 6],
    [`${RULES}code-review: { on: true, when: { paths: ["src/**", "  !*.md"] } }\n`, "`code-review.when.paths` must be a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches.", 6],
    [`${RULES}code-review: { on: true, when: { paths: ["src/**", "! *.md"] } }\n`, "`code-review.when.paths` must be a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches.", 6],
    [`${RULES}code-review: { on: true, when: { paths: ["src/**", "*.md "] } }\n`, "`code-review.when.paths` must be a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches.", 6],
    [`${RULES}code-review: { on: true, when: { paths: ["src/**", "!"] } }\n`, "`code-review.when.paths` must be a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches.", 6],
    [`${RULES}security: { when: { triage: pass } }\n`, "`security.on` must be true or false.", 6],
    [`${RULES}security: { onn: true }\n`, "`security.onn` is not a key; did you mean `security.on`?", 6],
    [`${RULES}security: on\n`, "`security` must be a mapping of on, for, when, clean and provider.", 6],
    [`${RULES}code-reveiw: { on: true }\n`, "`code-reveiw` is not a key; did you mean `code-review`?", 6],
    [`${RULES}blocks: {}\n`, "`blocks` is not a key; use extends, onFail, rules, actions, labels, groups, code-review, security, deslop, pace, pauseLabel or decide.", 6],
    [`${RULES}security: { on: true, whn: { triage: pass } }\n`, "`security.whn` is not a key; did you mean `security.when`?", 6],
    [`${RULES}security: { on: true, clean: { below: severe } }\n`, "`security.clean.below` must be low, medium, high or critical.", 6],
    [`${RULES}security: { on: true, clean: { minConfidence: 0.7 } }\n`, "`security.clean.minConfidence` is not available yet; remove it.", 6],
    [`${RULES}security: { on: true, clean: { coverage: full } }\n`, "`security.clean.coverage` is not available yet; remove it.", 6],
    [`${RULES}security: { on: true, provider: azure }\n`, "`security.provider` must be anthropic, openai, xai, google, opencode or custom.", 6],
    [`${RULES}code-review: { on: true, provider: anthropic }\nsecurity: { on: true, provider: openai }\n`, "`security.provider` is openai but `code-review.provider` is anthropic; blocks that are on must name the same provider.", 7],
    [`${RULES}security: { on: true, for: [maintainer] }\n`, "`security.for` names `maintainer`, which is not a group; did you mean `maintainers`?", 6],
    [`${RULES}security: { on: true, for: [reviewers] }\n`, "`security.for` names `reviewers`, which is not a group; define it under groups.", 6],
    [`${RULES}groups: { everyone: { association: [NONE] } }\n`, "`groups.everyone` is built in; name the group something else.", 6],
    [`${RULES}groups: { Core: { users: [octocat] } }\n`, "`groups.Core` must be named in lowercase words joined by hyphens, starting with a letter, at most 64 characters.", 6],
    [`${RULES}groups: { core: {} }\n`, "`groups.core` must set association, teams or users.", 6],
    [`${RULES}groups:\n  core: { association: [ADMIN] }\n`, "`groups.core.association` must be a list of OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE, MANNEQUIN or BOT.", 7],
    [`${RULES}groups:\n  core: { teams: [core] }\n`, "`groups.core.teams` must be a list of teams written org/team.", 7],
    [`${RULES}groups:\n  core: { members: [octocat] }\n`, "`groups.core.members` is not a key; use association, teams or users.", 7],
    [`${RULES}pace: { debounce: 30 }\n`, `\`pace.debounce\` must be ${DURATION}.`, 6],
    [`${RULES}pace: { maxWait: 0s }\n`, `\`pace.maxWait\` must be ${DURATION}.`, 6],
    [`${RULES}pace: { perHead: 0 }\n`, "`pace.perHead` must be a whole number of at least 1.", 6],
    [`${RULES}pace:\n  cap: { runs: 5 }\n`, `\`pace.cap.per\` must be ${DURATION}.`, 7],
    [`${RULES}pace: { backof: { pushes: 5 } }\n`, "`pace.backof` is not a key; did you mean `pace.backoff`?", 6],
    [`${RULES}pauseLabel: "${"x".repeat(51)}"\n`, "`pauseLabel` must be a label of at most 50 characters.", 6],
    [`${RULES}decide: { if: { triage: fail }, do: close }\n`, "`decide` must be a list of rules, each { if, do }.", 6],
    [`${RULES}decide:\n  - { if: {}, do: close }\n`, "`decide[0].if` must set a condition.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass } }\n`, `\`decide[0].do\` must be one of ${KINDS}, or a list of them.`, 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, od: approve }\n`, "`decide[0].od` is not a key; did you mean `decide[0].do`?", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: ship }\n`, `\`decide[0].do\` must be one of ${KINDS}.`, 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [approve, aprove] }\n`, `\`decide[0].do[1]\` must be one of ${KINDS}; did you mean \`approve\`?`, 7],
    [`${RULES}decide:\n  - { if: { triage: fail }, do: comment }\n`, "`decide[0].do` `comment` needs a target; write `{ do: comment, target: { body: … } }`.", 7],
    [`${RULES}decide:\n  - { if: { triage: unsure }, do: [close, request-review] }\n`, "`decide[0].do[1]` `request-review` needs a target; write `{ do: request-review, target: { to: codeowners } }`.", 7],
    [`${RULES}decide:\n  - { if: { triage: unsure }, do: [{ do: request-review, target: { to: author } }] }\n`, "`decide[0].do[0].target` must be `{ to: codeowners }`, `{ to: users, users: [ … ] }` or `{ to: teams, teams: [ … ] }`.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [{ do: approve, target: { to: author } }] }\n`, "`decide[0].do[0].target` must be removed; `approve` takes no target.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [{ od: approve }] }\n`, "`decide[0].do[0].od` is not a key; did you mean `decide[0].do[0].do`?", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [{ do: approve, when: { authr: [maintainers] } }] }\n`, "`decide[0].do[0].when.authr` is not a key; did you mean `decide[0].do[0].when.author`?", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [{ do: approve, when: { ci: [green] } }] }\n`, "`decide[0].do[0].when.ci` must be a list of `passing`, `failing`, `pending` or `none`.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [nothing, approve] }\n`, "`decide[0].do` can't mix `nothing` with other actions; keep one or the other.", 7],
    [`${RULES}decide:\n  - { if: { all: findings }, do: review }\n`, "`decide[0].if.all` must be clean.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [close, review] }\n`, "`decide[0].do` can't use `review` yet; use `request-review` or remove it.", 7],
    [`${RULES}decide:\n  - { if: { triage: [pass, maybe] }, do: approve }\n`, "`decide[0].if.triage` must be pass, fail or unsure, or a list of them.", 7],
    [`${RULES}decide:\n  - { if: { event: [pushed] }, do: approve }\n`, "`decide[0].if.event` must be a list of opened, updated, checks or ready.", 7],
    [`${RULES}${ON}decide:\n  - { if: { code-review: done }, do: approve }\n`, "`decide[0].if.code-review` must be clean, findings, incomplete or skipped, a list of them, or { findings: <severity> } with a severity of low, medium, high or critical.", 9],
    [`${RULES}${ON}decide:\n  - { if: { security: { findings: severe } }, do: review }\n`, "`decide[0].if.security` must be clean, findings, incomplete or skipped, a list of them, or { findings: <severity> } with a severity of low, medium, high or critical.", 9],
    [`${RULES}decide:\n  - { if: { autor: [maintainers] }, do: approve }\n`, "`decide[0].if.autor` is not a key; did you mean `decide[0].if.author`?", 7],
    [`${RULES}decide:\n  - { if: { author: [maintainer] }, do: approve }\n`, "`decide[0].if.author` names `maintainer`, which is not a group; did you mean `maintainers`?", 7],
    [`${RULES}deslop: { on: false }\ndecide:\n  - { if: { deslop: clean }, do: approve }\n`, "`decide[0].if.deslop`: `deslop` is not turned on in this file; set `deslop.on: true` or remove the condition.", 8],
    [`${RULES}${ON}decide:\n  - if: { triage: pass }\n    do: approve\n  - if: { code-review: [clean, incomplete] }\n    do: [approve, merge]\n`, "`decide[1].if.code-review` can't match incomplete in a rule that approves or merges; incomplete is never clean.", 11],
    [`${RULES}actions:\n  pass: [{ do: approve }]\ndecide:\n  - { if: { triage: pass }, do: approve }\n`, "`actions` and `decide` can't both be set; move the actions into decide.", 6],
    [`${RULES}actions:\n  pass: [{ do: aprove }]\n`, `\`actions.pass[0].do\` must be one of ${STEP_KINDS}; did you mean \`approve\`?`, 7],
    [`${RULES}actions:\n  fail:\n    - do: comment\n`, "`actions.fail[0]` `comment` needs a target; write `{ do: comment, target: { body: … } }`.", 8],
    [`${RULES}actions:\n  pass: [{ do: approve, when: { author: [ADMIN] } }]\n`, "`actions.pass[0].when.author` must be a list of `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`, `BOT`, group names, `everyone`, `{ team: org/team }` or `{ users: [ … ] }`.", 7],
    [`${RULES}actions:\n  pass: [{ do: approve, when: { author: [admins] } }]\n`, "`actions.pass[0].when.author` names `admins`, which is not a group; define it under groups.", 7],
    [`${RULES}decide:\n  - { if: { triage: pass }, do: [{ do: approve, when: { author: [maintainer] } }] }\n`, "`decide[0].do[0].when.author` names `maintainer`, which is not a group; did you mean `maintainers`?", 7],
    ["code-review: { on: true }\n", "`rules` must be a list of rules.", 1],
    [`rule: []\ncode-review: { on: true }\n`, "`rule` is not a key; did you mean `rules`?", 1],
    [`rules:\n  - check: model\n    id: tidy\n    text: "Is pauseLabel: set?"\n    reason: r\n    evidence: [maintainer-stated]\npauseLabel: "${"x".repeat(60)}"\n`, "`pauseLabel` must be a label of at most 50 characters.", 7],
  ])("refuses %#", (text, message, line) => {
    expect(problems(text)).toEqual([{ message, line }]);
  });

  test("every key the grammar takes is said in the file's terms when it is wrong", () => {
    function propsOf(node: Type): ReadonlyArray<{ key: PropertyKey; value: Type }> {
      try {
        return node.props as ReadonlyArray<{ key: PropertyKey; value: Type }>;
      } catch {
        return [];
      }
    }
    function pathsOf(node: Type, path: readonly PropertyKey[]): PropertyKey[][] {
      return propsOf(node).flatMap(({ key, value }) => [[...path, key], ...pathsOf(value, [...path, key])]);
    }
    function nested(path: readonly PropertyKey[], leaf: unknown): unknown {
      return path.reduceRight((value, key) => (typeof key === "number" ? [value] : { [key]: value }), leaf);
    }
    const seeds: Array<[Type, PropertyKey[]]> = [
      [policyWorkflowSchema, []],
      [policyWorkflowSchema.get("groups", "core").exclude("undefined"), ["groups", "core"]],
      [policyWorkflowSchema.get("decide", 0).exclude("undefined"), ["decide", 0]],
    ];
    const paths = seeds.flatMap(([node, path]) => pathsOf(node, path));
    expect(paths.length).toBeGreaterThan(30);
    for (const path of paths) {
      const file = { rules: [{ check: "ci-green", text: "CI passes.", reason: "Required.", evidence: ["maintainer-stated"] }], ...(nested(path, -1) as object) };
      const at = path.map((key, index) => (typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`)).join("");
      const said = problems(JSON.stringify(file)).map((problem) => problem.message);
      const escaped = at.replace(/[.[\]]/g, "\\$&");
      expect({ at, said }).toEqual({ at, said: expect.arrayContaining([expect.stringMatching(new RegExp(`^\`${escaped}\` must be`))]) });
    }
  });
});

describe("author groups", () => {
  const groups = {
    core: { teams: ["acme/core"] },
    maintainers: { users: ["octocat"] },
    regulars: { association: ["CONTRIBUTOR" as const], users: ["octocat"] },
  };
  function author(over: Partial<StepAuthor>): StepAuthor {
    return { login: "octocat", kind: "CONTRIBUTOR", teams: [], ...over };
  }

  test("the first file group matching wins, built-in groups are facts no file group of that name replaced, and everyone always holds", () => {
    expect(authorGroupsOf(groups, author({}))).toEqual(["maintainers", "external", "everyone"]);
    expect(authorGroupsOf(groups, author({ teams: ["acme/core"], kind: "MEMBER" }))).toEqual(["core", "everyone"]);
    expect(authorGroupsOf({}, author({ kind: "MEMBER" }))).toEqual(["maintainers", "everyone"]);
  });

  test("an unknown kind, or teams that can't be read deciding the first group, leaves the author's groups not known", () => {
    expect(authorGroupsOf(groups, author({ kind: undefined }))).toBeUndefined();
    expect(authorGroupsOf(groups, author({ teams: undefined }))).toBeUndefined();
    expect(authorGroupsOf(groups, author({ teamsUnknown: ["acme/core"] }))).toBeUndefined();
    expect(authorGroupsOf({ maintainers: { users: ["octocat"] }, ...groups }, author({ teams: undefined }))).toEqual(["maintainers", "external", "everyone"]);
  });

  test("widening a group, or reordering groups, is a difference from the saved policy", () => {
    const pack = readCheckPack(readPolicyFile(`${RULES}groups:\n  core: { teams: [acme/core] }\n  staff: { association: [MEMBER] }\n`, REPO), REPO);
    const wider = { ...pack, groups: { core: { teams: ["acme/core"] }, staff: { association: ["MEMBER" as const, "CONTRIBUTOR" as const] } } };
    expect(policyDifferences(pack, pack)).toEqual([]);
    expect(policyDifferences(pack, wider)).toEqual([{ rule: "The group staff", saved: ["MEMBER"], file: ["MEMBER", "CONTRIBUTOR"], instead: "The group staff: MEMBER, CONTRIBUTOR instead of MEMBER." }]);
    expect(policyDifferences(pack, { ...pack, groups: { staff: pack.groups!.staff!, core: pack.groups!.core! } })).toEqual([
      { rule: "The order groups are matched in", saved: ["core", "staff"], file: ["staff", "core"], instead: "Triage will match groups in the order staff, core." },
    ]);
  });

  test("a step for named people names them", () => {
    const pack = readCheckPack(readPolicyFile(RULES, REPO), REPO);
    const named = { ...pack, actions: { ...pack.actions, pass: [{ do: "approve" as const, when: { author: [{ users: ["octocat"] }, { team: "core" }] } }] } };
    expect(policyDifferences(pack, named).find((difference) => difference.rule === "When it passes")?.instead).toBe("When it passes, Triage will approve for @octocat, @core.");
  });

  test("a step for a group holds by the author's groups, everyone always, and is not known without them", () => {
    const subject = { linkedIssue: false, ci: "passing" as const, files: 1, lines: 1 };
    const known = { ...author({}), groups: authorGroupsOf(groups, author({})) };
    expect(whenHolds({ author: [{ group: "maintainers" }] }, { ...subject, author: known }).matches).toBe(true);
    expect(whenHolds({ author: [{ group: "regulars" }] }, { ...subject, author: known }).matches).toBe(false);
    expect(whenHolds({ author: [{ group: "everyone" }] }, { ...subject, author: author({}) }).matches).toBe(true);
    expect(whenHolds({ author: [{ group: "core" }] }, { ...subject, author: author({}) })).toEqual({ matches: undefined, reason: "it is not known whether the author is core" });
  });
});
