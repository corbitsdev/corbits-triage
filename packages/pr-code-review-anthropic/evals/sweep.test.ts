import { expect, test } from "bun:test";
import { candidates, review, type Candidate } from "@corbits/pr-code-review/actions/review";
import { parseFindings } from "@corbits/pr-code-review/findings";
import type { CaseKey } from "./cases.js";
import { commentsOf, KEEP_ALL, scoreCutoff, type SavedOutputs } from "./sweep.js";

const KEY: CaseKey = { id: "c", kind: "defect", bugs: [{ id: "b1", reach: "diff", sites: [{ path: "src/a.ts", start: 10, end: 10 }] }], ignored: [] };
function saved(bundles: object[][], kept: Candidate[]): SavedOutputs {
  const find = bundles.map((findings) => ({ reply: JSON.stringify({ findings }) }));
  function foundOf(output: { reply: string }): Candidate[] {
    const parsed = parseFindings(output.reply);
    if ("unparsable" in parsed) throw new Error(parsed.unparsable);
    return parsed.findings.map((finding) => ({ ...finding, finders: ["diff"], reports: 1 }));
  }
  const findings = [...kept].sort((a, b) => a.priority - b.priority);
  return {
    find, candidates: { found: find.flatMap(foundOf), kept }, checks: { findings },
    check: findings.map(() => ({ reply: JSON.stringify({ verdict: "real", reason: "cited" }) })),
    review: { comments: findings.map((finding) => ({ ...finding, agreement: { finders: 1 } })) },
  };
}
const BUG = { path: "src/a.ts", start: 10, end: 10, code: "  return a - b;", title: "add subtracts", priority: 1 };
const ALARM = { path: "src/b.ts", start: 50, end: 50, code: "  log(x);", title: "noisy log", priority: 3 };
const OUTPUTS = saved([
  [{ file: BUG.path, line: BUG.start, code: BUG.code, title: BUG.title, priority: 1, confidence: "0.6" }, { ...ALARM, confidence: 0.3 }],
  [{ ...BUG, confidence: 0.9 }],
], [{ ...BUG, finders: ["diff"], reports: 2 }, { ...ALARM, finders: ["diff"], reports: 1 }]);

test("mapped finder replies retain top duplicate confidence without manufacturing finder agreement", () => {
  expect(commentsOf(OUTPUTS).map(({ confidence, finders }) => ({ confidence, finders }))).toEqual([{ confidence: 0.9, finders: 1 }, { confidence: 0.3, finders: 1 }]);
});
test("same-title findings at different anchors keep their own confidences and replay refuses changed anchors", () => {
  const shifted = { ...BUG, start: 12, end: 12 };
  const outputs = saved([[{ ...BUG, confidence: 0.9 }, { ...shifted, confidence: 0.2 }]], [{ ...BUG, finders: ["diff"], reports: 1 }, { ...shifted, finders: ["diff"], reports: 1 }]);
  expect(commentsOf(outputs).map((c) => c.confidence)).toEqual([0.9, 0.2]);
  outputs.review.comments[1]!.start = 10;
  expect(() => commentsOf(outputs)).toThrow("does not replay");
});
for (const title of [undefined, ""]) {
  for (const why of [undefined, "This breaks callers"]) {
    test(`replay preserves production ${why ? "explanation" : "anchor"} fallback for ${title === undefined ? "omitted" : "empty"} title`, async () => {
      const finding = { path: "src/a.ts", start: 27, end: 29, priority: 2, confidence: 0.8, ...(title !== undefined && { title }), ...(why !== undefined && { why }) };
      const find = [{ reply: JSON.stringify({ findings: [finding] }) }];
      const folded = await candidates({ find: { output: find } });
      const findings = folded.kept.map((candidate) => ({ ...candidate, agreement: { finders: 1, reports: 1 } }));
      const check = [{ reply: JSON.stringify({ verdict: "real", reason: "src/a.ts:27 proves it" }) }];
      const posted = await review({ candidates: { output: folded }, checks: { output: { findings, checks: [] } }, check: { output: check } });
      const expectedTitle = why ?? "Defect at src/a.ts:27";
      expect(posted.comments[0]).toMatchObject({ title: expectedTitle, body: why ?? "", path: finding.path, start: 27, end: 29 });
      const outputs = { find, candidates: folded, checks: { findings }, check, review: posted };
      expect(commentsOf(outputs)).toEqual([{ path: finding.path, start: 27, end: 29, priority: 2, finders: 1, confidence: 0.8 }]);
      posted.comments[0]!.title = `${expectedTitle} changed`;
      expect(() => commentsOf(outputs)).toThrow("does not replay");
      posted.comments[0]!.title = expectedTitle;
      for (const altered of [{ path: "src/b.ts" }, { start: 28 }, { end: 30 }]) {
        const changed = { ...outputs, review: { ...posted, comments: [{ ...posted.comments[0]!, ...altered }] } };
        expect(() => commentsOf(changed)).toThrow("does not replay");
      }
    });
  }
}

test("keeping everything scores the whole review; a cutoff drops the false alarm and keeps the bug", () => {
  const replayed = [{ key: KEY, comments: commentsOf(OUTPUTS) }];
  expect(scoreCutoff(replayed, KEEP_ALL)).toMatchObject({ comments: 2, caught: 1, falseAlarms: 1, precision: 0.5 });
  expect(scoreCutoff(replayed, { confidence: 0.5, priority: Number.POSITIVE_INFINITY })).toMatchObject({ comments: 1, caught: 1, falseAlarms: 0, precision: 1 });
});
