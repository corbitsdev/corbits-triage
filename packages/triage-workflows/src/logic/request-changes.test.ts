import { describe, expect, test } from "bun:test";
import { getReviews, REQUEST_CHANGES_DO_MARKER, type GithubFetch } from "@corbits/github-reads";
import { DEFAULT_REPO_POLICY, defaultActions, emptyPack, isPatternsCheck, readCheckPack, readPolicyFile, type CheckPack } from "@corbits/triage-contracts";
import { approvalHeldBy, changesWanted, evaluateActions, heldApprovals } from "./actions.js";
import { deriveState, type PrFacts } from "./checks.js";
import { buildFacts } from "./facts.js";
import { NO_FACTS } from "./item.js";
import { patternsResult } from "./patterns.js";
import { inlineCode, MAX_MIRROR_COMMENT_BYTES, renderVerdict } from "./render.js";

const facts: PrFacts = {
  ...NO_FACTS,
  repo: "acme/widgets",
  number: 8,
  title: "feat: search",
  author: "octocat",
  tier: "external",
  headSha: "def",
  state: "open",
  draft: false,
  mergeable: true,
  checks: "success",
  reviewers: ["alice"],
  reviewedBy: [],
  approvals: 0,
  labels: [],
  assignees: [],
  paths: ["src/search.ts"],
  events: ["updated"],
};

const pack: CheckPack = {
  ...emptyPack("acme/widgets"),
  checks: { "no-merge-conflicts": { enabled: true }, "ci-green": { enabled: true } },
  actions: { ...defaultActions(), pass: [{ do: "approve" }], fail: [{ do: "request-changes" }] },
};

function input(over: Partial<PrFacts>, using = pack) {
  const pr = { ...facts, ...over };
  const det = deriveState(pr, undefined, using);
  const rendered = renderVerdict({ repoSource: "github", author: pr.author, repo: pr.repo, headSha: pr.headSha, det, answers: null, choice: { pass: 0.9, fail: 0.05, cant_tell: 0.05 } });
  return { rendered, input: { facts: pr, checks: rendered.checks, verdict: rendered.verdict, reason: rendered.reason, pack: using } };
}

function suggested(over: Partial<PrFacts>, using = pack) {
  const { rendered, input: actionInput } = input(over, using);
  return heldApprovals(evaluateActions(actionInput), approvalHeldBy(rendered.verdict, actionInput.facts.checks), actionInput.facts);
}

function reviewBody(actions: ReturnType<typeof suggested>): string {
  for (const action of actions) {
    if (action.kind === "request-changes" && "target" in action && "body" in action.target) return action.target.body;
  }
  throw new Error("no request-changes body");
}

const APP = "corbits-triage[bot]";

/** So only the App's own marked review is triage's. */
async function reviewFacts(rows: unknown[]): Promise<Partial<PrFacts>> {
  const gh: GithubFetch = async () => Response.json(rows);
  const reviews = await getReviews(gh, "acme/widgets", 8, APP);
  const { changesRequested, reviewAnswered, triageRequested } = buildFacts("acme/widgets", 8, { author: "octocat", branch: "a", sha: "def" }, [], reviews, [], DEFAULT_REPO_POLICY);
  return { changesRequested, reviewAnswered, triageRequested };
}

function markedRequest(login: string) {
  return { id: 1, user: { login, type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: "abc", submitted_at: "2026-10-01T10:00:00Z", body: `${REQUEST_CHANGES_DO_MARKER}\nTriage requests changes:` };
}

describe("the request-changes Do", () => {
  test("triage's own request on an earlier head is not a reviewer's, so the fixed head approves", async () => {
    expect(suggested(await reviewFacts([markedRequest(APP)]))).toEqual([expect.objectContaining({ kind: "approve", list: "pass" })]);
  });

  test("another bot's request carrying the marker is still a reviewer's", async () => {
    expect((await reviewFacts([markedRequest("other-review-bot[bot]")])).changesRequested).toEqual(["other-review-bot[bot]"]);
  });

  test("a pack that no longer requests changes takes back the App's standing request, and has nothing to decide without one", async () => {
    const plain = { ...pack, actions: defaultActions() };
    expect(changesWanted(input(await reviewFacts([markedRequest(APP)]), plain).input)).toBe(false);
    expect(changesWanted(input({}, plain).input)).toBeUndefined();
  });

  test("lists every failed rule that is the author's to fix, and stops wanting changes once they are fixed", () => {
    expect(suggested({ checks: "failure", failingChecks: ["build"], mergeable: false })).toEqual([
      expect.objectContaining({ kind: "request-changes", list: "fail", target: { body: `Triage requests changes:\n- CI green: required checks are failing\n  - ${inlineCode("build")}\n- Merge conflicts: merge conflicts with base` } }),
    ]);
    expect(changesWanted(input({}).input)).toBe(false);
  });

  test("is skipped when nothing failed is the author's to fix", () => {
    expect(suggested({ changesRequested: ["maya"] })).toEqual([expect.objectContaining({ kind: "request-changes", skipped: true })]);
  });

  test("names each code-pattern finding under the rule, and leaves out a skipped file and a rule asked of a maintainer", () => {
    const policy = `rules:
  - id: conventions
    check: code-patterns
    text: Follow our conventions.
    reason: Review time.
    evidence: [maintainer-stated]
    presets: [convention]
  - id: style-notes
    check: code-patterns
    text: Style.
    reason: Review time.
    evidence: [maintainer-stated]
    onFail: ask
    presets: [convention]
`;
    const using = { ...readCheckPack(readPolicyFile(policy, "acme/widgets")), actions: { ...defaultActions(), fail: [{ do: "request-changes" as const }] } };
    const content = "const b = y ?? 0;\nconst c = p ? 1\n  : q ? 2 : 3;\n";
    const patch = "@@ -0,0 +1,3 @@\n+const b = y ?? 0;\n+const c = p ? 1\n+  : q ? 2 : 3;\n";
    const files = [
      { path: "src/a.ts", status: "added", additions: 3, deletions: 0, patch },
      { path: "vendor/c.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+const c = z ?? 0;\n" },
    ];
    const patterns = Object.fromEntries(using.custom.filter(isPatternsCheck).map((rule) => [rule.id, patternsResult(rule, files, { "src/a.ts": content }, "github")]));
    const actions = suggested({ files, patterns, checks: "success", mergeable: true }, using);
    const body = reviewBody(actions);
    expect(body).toBe(`Triage requests changes:\n- Conventions: added code matches a code pattern\n  - ${inlineCode("src/a.ts:1 zero-fallback: Invented fallback `?? 0`; handle the missing value instead.")}\n  - ${inlineCode("src/a.ts:2-3 nested-ternary: Nested ternary; use if statements or a lookup.")}`);
    expect(body).not.toContain("vendor/c.ts");
    expect(body).not.toContain("Style notes");
    expect(actions).toEqual([expect.objectContaining({ kind: "request-changes", list: "fail" })]);
  });

  test("cuts the review at the byte cap and counts the finding lines left out", () => {
    const names = Array.from({ length: 900 }, (_, index) => `check-${String(index).padStart(4, "0")}-${"x".repeat(60)}`);
    const body = reviewBody(suggested({ checks: "failure", failingChecks: names, mergeable: false }));
    const full = ["Triage requests changes:", "- CI green: required checks are failing", ...names.map((name) => `  - ${inlineCode(name)}`), "- Merge conflicts: merge conflicts with base"];
    const lines = body.split("\n");
    const trailer = lines.at(-1) ?? "";
    const prefix = lines.slice(0, -1);
    const omitted = full.slice(prefix.length).filter((line) => line.trimStart().startsWith("- ")).length;
    expect(new TextEncoder().encode(full.join("\n")).byteLength).toBeGreaterThan(MAX_MIRROR_COMMENT_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_MIRROR_COMMENT_BYTES);
    expect(full.slice(0, prefix.length)).toEqual(prefix);
    expect(trailer).toBe(`- and ${omitted} more`);
    expect(omitted).toBeGreaterThan(0);
    const next = full[prefix.length];
    if (next !== undefined) {
      const still = full.slice(prefix.length + 1).filter((line) => line.trimStart().startsWith("- ")).length;
      const longer = [...prefix, next, ...(still > 0 ? [`- and ${still} more`] : [])].join("\n");
      expect(new TextEncoder().encode(longer).byteLength).toBeGreaterThan(MAX_MIRROR_COMMENT_BYTES);
    }
  });
});
