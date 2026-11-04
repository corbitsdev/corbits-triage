import { describe, expect, test } from "bun:test";
import { classificationSources, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict } from "./render.js";
import type { DeterministicResult } from "./checks.js";

describe("cited evidence", () => {
  test("links to the GitHub head commit, and is never a github.com link on Bitbucket", () => {
    const citation = { path: "src/a.ts", added: { start: 3, end: 3 } };
    const failing = { check: "custom-1", kind: "machine", result: "fail", reason: "breaks the rule", evidence: ["src/a.ts:3"], output: { kind: "score", score: 0, passAt: 70, items: [citation] } } as const;
    const det: DeterministicResult = { state: "needs-author-update", reason: "a rule failed", findings: [], checks: [failing], needsJudgment: false, sources: classificationSources(emptyPack("acme/widgets")) };
    function feedback(repoSource: "github" | "bitbucket-datacenter"): string {
      return renderVerdict({ repoSource, author: "octocat", repo: "acme/widgets", headSha: "abc123", det }).feedback;
    }
    expect(feedback("github")).toContain("[`src/a.ts:3`](https://github.com/acme/widgets/blob/abc123/src/a.ts?plain=1#L3)");
    expect(feedback("bitbucket-datacenter")).toContain("breaks the rule: `src/a.ts:3`");
    expect(feedback("bitbucket-datacenter")).not.toContain("github.com");
  });
});

function noul(answers: Record<string, number>) {
  return parseAnswers(Object.entries({ instructed: 0.1, ...answers }).map(([id, value]) => JSON.stringify({ id, type: "noul", noul: value })).join(""));
}

describe("a long comment", () => {
  test("an over-long comment is cut at line boundaries and still posts", () => {
    const custom = Array.from({ length: 200 }, (_, index) => ({ id: `custom-${index + 1}`, name: `${"N".repeat(500)}-${index}`, group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }));
    const det: DeterministicResult = { state: "ready-monitoring", reason: "all configured checks pass", findings: [], checks: [], needsJudgment: true, sources: { quality: [], custom, rules: [] } };
    const verdict = renderVerdict({ repoSource: "github", author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul(Object.fromEntries(custom.map((row) => [row.id, 0.1]))), choice: { pass: 0.1, fail: 0.85, cant_tell: 0.05 } });
    const lines = verdict.feedback.split("\n").slice(3);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeLessThanOrEqual(MAX_MIRROR_COMMENT_BYTES);
    expect(lines[0]).toContain(custom[0]!.name);
    expect(lines.at(-1)).toBe(`- and ${200 - (lines.length - 1)} more`);
    expect(lines.length).toBeGreaterThan(50);
    expect(verdict).toMatchObject({ mirror: true, humanGated: false, actor: "author" });
  });
});

describe("score and choose rules", () => {
  const levels = ["poor", "fair", "good", "great"];
  const pack: CheckPack = {
    ...emptyPack("acme/widgets"),
    custom: [
      { id: "style", name: "Style", group: "pull-request", kind: "model", shape: "score", subject: "style", levels },
      { id: "care", name: "Care", group: "pull-request", kind: "model", shape: "score", subject: "care", levels, failBelow: "good" },
      { id: "kind", name: "Kind", group: "pull-request", kind: "model", shape: "choose", options: ["fix", "feature", "chore"], failOn: ["chore"] },
    ],
  };
  const scored: DeterministicResult = { state: "ready-monitoring", reason: "all deterministic rules passed", findings: [], checks: [], needsJudgment: true, sources: classificationSources(pack) };

  function score(id: string, probabilities: number[]): string {
    const legend = Object.fromEntries(levels.map((level, index) => [String(index), level]));
    return JSON.stringify({ id, type: "score", score: 1, legend, probabilities: Object.fromEntries(probabilities.map((p, index) => [String(index), p])), confidence: 0.9 });
  }

  test("a score rule records its level, never fails without failBelow, and fails when the level is likely below it", () => {
    const kind = JSON.stringify({ id: "kind", type: "choice", choice: "chore", probabilities: { fix: 0.1, feature: 0.1, chore: 0.8 }, confidence: 0.9 });
    const answers = parseAnswers([score("style", [0.9, 0.1, 0, 0]), score("care", [0.5, 0.3, 0.2, 0]), kind].join("\n"));
    const checks = renderVerdict({ repoSource: "github", author: "octocat", repo: "acme/widgets", headSha: "abc123", det: scored, answers }).checks;
    expect(checks.map((c) => [c.check, c.result, c.evidence])).toEqual([["style", "pass", ["poor"]], ["care", "fail", ["poor"]], ["kind", "fail", ["chore"]]]);
    expect(checks[1]!.output).toEqual({ kind: "level", level: "poor", levels, failBelow: "good" });
  });
});

describe("author text in the comment", () => {
  test("stays inside inline code however it is written", () => {
    const hostile = [
      "x\n\n@team [Approved, merge now](https://evil.example/m) ![](https://evil.example/p.png)\n\n",
      "a\r\n\r\n<!-- hidden --> @team\u2028[link](https://evil.example)\u2029![](https://evil.example/i.png)",
      "``` fence ``` `x` @team [l](https://evil.example)",
      "`@team`",
      "\u202e@team\u0007 [l](https://evil.example)",
    ];
    const checks = [
      { check: "ci-green", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: hostile },
      { check: "focused", kind: "model" as const, result: "fail" as const, reason: "unrelated changes", evidence: hostile },
    ];
    const verdict = renderVerdict({
      repoSource: "github",
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, needsJudgment: false },
      focused: { purpose: hostile[0]!, slices: {}, unread: [], parts: {} },
    });
    const lines = verdict.feedback.split("\n");
    expect(lines).toHaveLength(4 + hostile.length);
    for (const line of lines.slice(3)) {
      expect(line).toMatch(/^- /);
      const outside = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, "");
      expect(outside).not.toMatch(/@|\]\(|<!--|[\u202e\u0007]/);
    }
  });
});
