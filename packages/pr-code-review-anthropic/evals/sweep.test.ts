import { expect, test } from "bun:test";
import { orderedGroups, type Candidate, type Group } from "@corbits/pr-code-review/actions/review";
import { parseFindings, type Site } from "@corbits/pr-code-review/findings";
import type { CaseKey } from "./cases.js";
import { commentsOf, KEEP_ALL, scoreCutoff, type SavedOutputs } from "./sweep.js";

const KEY: CaseKey = { id: "c", kind: "defect", bugs: [{ id: "b1", reach: "diff", sites: [{ path: "src/a.ts", start: 10, end: 10 }] }], ignored: [] };

function reply(findings: object[]): { reply: string } {
  return { reply: `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`` };
}

function foundOf(output: { reply: string }, finder: "diff" | "repo"): Candidate[] {
  const parsed = parseFindings(output.reply);
  if ("unparsable" in parsed) throw new Error(parsed.unparsable);
  return parsed.findings.map((finding) => ({ ...finding, finders: [finder], reports: 1 }));
}

/** Saved outputs as the workflow writes them, from the finder replies, the kept candidates, the consolidate step's groups and the sites it anchored them at. */
function saved(diff: object[], repo: object[], kept: Candidate[], groups: Group[], sites: Site[] = kept.map(({ path, start, end }) => ({ path, start, end }))): SavedOutputs {
  const findDiff = reply(diff);
  const findRepo = reply(repo);
  const consolidated = { groups, sites, unreadFindings: [] };
  const findings = orderedGroups(kept, consolidated).map((o) => o.finding);
  return {
    findDiff,
    findRepo,
    candidates: { found: [...foundOf(findDiff, "diff"), ...foundOf(findRepo, "repo")], kept },
    consolidate: { reply: JSON.stringify(consolidated) },
    check: [],
    writeInput: { findings },
    review: { comments: findings.map((f) => ({ ...f, title: `written ${f.title}` })) },
  };
}

const BUG = { path: "src/a.ts", start: 10, end: 10, code: "  return a - b;", title: "add subtracts", priority: 1 };
const ALARM = { path: "src/b.ts", start: 50, end: 50, code: "  log(x);", title: "noisy log", priority: 3 };

// Both finders report the bug, the diff finder in other shapes the parser reads; the diff finder alone raises a false alarm.
const OUTPUTS = saved(
  [{ file: BUG.path, line: BUG.start, code: BUG.code, title: BUG.title, priority: 1, confidence: "0.6" }, { location: { path: ALARM.path, start: ALARM.start }, code: ALARM.code, title: ALARM.title, priority: 3, confidence: 0.3 }],
  [{ ...BUG, confidence: 0.9 }],
  [{ ...BUG, finders: ["diff", "repo"], reports: 2 }, { ...ALARM, finders: ["diff"], reports: 1 }],
  [{ defect: "", members: [0], representative: 0 }],
);

test("each comment carries its group's top confidence and agreement, whatever shape the finder wrote", () => {
  expect(commentsOf(OUTPUTS).map(({ confidence, finders }) => ({ confidence, finders }))).toEqual([
    { confidence: 0.9, finders: 2 },
    { confidence: 0.3, finders: 1 },
  ]);
});

test("findings anchored at one site with one title keep their own groups' confidences", () => {
  const twin = { path: "src/a.ts", start: 10, end: 10, title: "same words", priority: 2 };
  const shifted = { ...twin, start: 12, end: 12 };
  const outputs = saved(
    [{ ...twin, confidence: 0.9 }, { ...shifted, confidence: 0.2 }],
    [],
    [{ ...twin, finders: ["diff"], reports: 1 }, { ...shifted, finders: ["diff"], reports: 1 }],
    [
      { defect: "", members: [0], representative: 0 },
      { defect: "", members: [1], representative: 1 },
    ],
    [twin, twin],
  );
  expect(commentsOf(outputs).map((c) => c.confidence)).toEqual([0.9, 0.2]);
});

test("keeping everything scores the whole review; a cutoff drops the false alarm and keeps the bug", () => {
  const replayed = [{ key: KEY, comments: commentsOf(OUTPUTS) }];
  expect(scoreCutoff(replayed, KEEP_ALL)).toMatchObject({ comments: 2, caught: 1, falseAlarms: 1, precision: 0.5 });
  expect(scoreCutoff(replayed, { oneFinder: 0.5, bothFinders: 0, priority: Number.POSITIVE_INFINITY })).toMatchObject({ comments: 1, caught: 1, falseAlarms: 0, precision: 1 });
});
