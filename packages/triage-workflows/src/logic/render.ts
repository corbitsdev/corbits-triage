import { render, type Rendered, type TriageState } from "@corbits/rule-packs";
import type { CheckResult, DeterministicResult } from "./checks.js";
import { asText } from "./extract.js";
import { actionText, failureText, passText, qualityQuestions } from "./quality.js";

interface JevDecision {
  id: string;
  type: string;
  noul?: number;
}

/** The adapter emits one JSON decision object per delta, concatenated in the reply. */
function jevDecisions(text: string): JevDecision[] {
  const out: JevDecision[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && --depth === 0) {
      try {
        const d = JSON.parse(text.slice(start, i + 1)) as JevDecision;
        if (typeof d.id === "string") out.push(d);
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** Each answer is the probability that the pull request passes that check. */
export function parseAnswers(reply: unknown): Record<string, number> {
  const answers: Record<string, number> = {};
  for (const d of jevDecisions(asText(reply))) if (d.type === "noul" && typeof d.noul === "number") answers[d.id] = d.noul;
  return answers;
}

export interface RenderInput {
  author: string;
  det: DeterministicResult;
  answers?: Record<string, number> | null;
  judgeError?: string;
  /** Logins of requested reviewers. */
  reviewers?: string[];
}

export type Actor = "author" | "maintainer" | "system";

export interface RenderOutput extends Rendered {
  mirror: boolean;
  duplicate: boolean;
  /** Only a human-confirmed duplicate closes a PR; no automated path sets this. */
  close: boolean;
  confidence: number | "unknown";
  degraded: "inference-outage" | "error" | null;
  checks: CheckResult[];
  /** The reason the verdict was rendered with. */
  reason: string;
  nextAction: string;
  actor: Actor;
  /** The comment to post for the author; empty when nothing is required of them. */
  feedback: string;
}

type Sources = DeterministicResult["sources"];

interface Step {
  actor: Actor;
  action: string;
}

// Only these states let model answers drive the verdict; anything worse is driven by its machine findings.
const JUDGED_STATES = new Set<TriageState>(["ready-monitoring", "awaiting-review"]);
const ACTOR_ORDER: Actor[] = ["author", "maintainer", "system"];
const MAX_ACTIONS = 2;

function modelChecks(sources: NonNullable<Sources>, answers: Record<string, number> | null | undefined, unavailable: string): CheckResult[] {
  return qualityQuestions(sources).map(({ id }) => {
    const p = answers?.[id];
    if (p === undefined) return { check: id, kind: "model", result: "unconfirmed", reason: unavailable, evidence: [] };
    const failed = p < 0.5;
    return { check: id, kind: "model", result: failed ? "fail" : "pass", reason: failed ? failureText(id, sources) : passText(id, sources), evidence: [] };
  });
}

function recordedModelChecks({ det, answers, judgeError }: RenderInput): CheckResult[] {
  if (!det.sources) return [];
  if (!det.needsJudgment) return modelChecks(det.sources, null, "not asked");
  return modelChecks(det.sources, judgeError === undefined ? answers : null, "decision model unavailable");
}

function withoutLimit(evidence: string[]): string {
  return evidence.map((e) => e.replace(/ \(max .*\)$/, "")).join(", ");
}

function failedStep(c: CheckResult, sources: Sources): Step {
  switch (c.check) {
    // Informational: marking a draft ready is the author's call, never asked of them.
    case "draft": return { actor: "maintainer", action: "Review once marked ready" };
    case "ci": return { actor: "author", action: c.evidence.length ? `Fix failing CI: ${c.evidence.join(", ")}` : "Fix failing CI" };
    case "conflicts": return { actor: "author", action: "Resolve merge conflicts" };
    case "paths": return { actor: "author", action: `Remove changes under ${c.evidence.join(", ")}` };
    case "size": return { actor: "author", action: `Split into smaller pull requests (${withoutLimit(c.evidence)})` };
    case "issue": return { actor: "author", action: "Link an issue" };
    case "review": return { actor: "author", action: `Address requested changes from ${c.evidence.map((e) => e.replace(/^changes requested by /, "")).join(", ")}` };
    case "duplicate": return { actor: "maintainer", action: `Confirm duplicate of ${c.evidence.join(", ")} or keep` };
    case "reviewers": return { actor: "maintainer", action: "Assign a reviewer" };
    case "drift": return { actor: "maintainer", action: `Decide on base drift (${withoutLimit(c.evidence)})` };
    default: return { actor: "author", action: c.kind === "model" && sources ? actionText(c.check, sources) : `Fix ${c.check}` };
  }
}

function unconfirmedSteps(c: CheckResult, sources: Sources): Step[] {
  if (c.check === "conflicts") return [{ actor: "system", action: "Wait for GitHub to compute mergeability" }];
  if (c.kind === "model" && sources && c.reason !== "not asked") return [{ actor: "maintainer", action: `Confirm ${passText(c.check, sources)}` }];
  return [];
}

function nextStep(checks: CheckResult[], sources: Sources, reviewers: string[]): { actor: Actor; nextAction: string } {
  const failing = checks.filter((c) => c.result === "fail").map((c) => failedStep(c, sources));
  const steps = failing.length ? failing : checks.filter((c) => c.result === "unconfirmed").flatMap((c) => unconfirmedSteps(c, sources));
  if (!steps.length) {
    const requested = reviewers.length ? ` — ${reviewers.map((r) => `@${r}`).join(", ")} requested` : "";
    return { actor: "maintainer", nextAction: `Review and merge${requested}` };
  }
  const ordered = ACTOR_ORDER.flatMap((actor) => steps.filter((s) => s.actor === actor));
  const actions = ordered.map((s) => s.action);
  const more = actions.length > MAX_ACTIONS ? ` and ${actions.length - MAX_ACTIONS} more` : "";
  return { actor: ordered[0]!.actor, nextAction: `${actions.slice(0, MAX_ACTIONS).join("; ")}${more}` };
}

/** Only checks the author can fix are posted; everything else is for maintainers in the portal. */
function authorComment(author: string, checks: CheckResult[], sources: Sources): string {
  const mine = checks.filter((c) => c.result === "fail" && failedStep(c, sources).actor === "author");
  if (!mine.length) return "";
  const lines = mine.map((c) => `- ${c.reason}${c.evidence.length ? `: ${c.evidence.join(", ")}` : ""}`);
  return [`@${author}, please address the following:`, ...lines].join("\n");
}

function withChecks<T extends Rendered>(rendered: T, checks: CheckResult[], { author, sources, reviewers }: { author: string; sources: Sources; reviewers: string[] }) {
  return { ...rendered, ...nextStep(checks, sources, reviewers), feedback: authorComment(author, checks, sources), checks };
}

export function renderVerdict(input: RenderInput): RenderOutput {
  const { author, det, answers, judgeError, reviewers = [] } = input;
  const ctx = { author, sources: det.sources, reviewers };
  const checks = [...det.checks, ...recordedModelChecks(input)];
  if (!det.needsJudgment || !det.sources || !JUDGED_STATES.has(det.state)) {
    const duplicate = det.duplicateOf !== null && det.state === "needs-decision";
    const verdict = withChecks({ ...render(det.state), mirror: det.state !== "stale-unknown", duplicate, close: false, confidence: "unknown" as const, degraded: null, reason: det.reason }, det.checks, ctx);
    return { ...verdict, checks };
  }
  const sources = det.sources;
  const asked = qualityQuestions(sources).map((q) => q.id);
  const passes = asked.map((id) => answers?.[id]);
  if (judgeError !== undefined || passes.some((p) => p === undefined)) {
    const reason = `decision model unavailable: ${judgeError ?? "no answer"}`;
    return withChecks({ ...render(det.state, { humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown" as const, degraded: "inference-outage" as const, reason }, checks, ctx);
  }
  const scores = passes as number[];
  const confidence = Math.round(Math.min(...scores.map((p) => Math.max(p, 1 - p))) * 100) / 100;
  const failing = asked.filter((_, i) => scores[i]! < 0.5);
  const reason = failing.length ? failing.map((id) => failureText(id, sources)).join("; ") : det.reason;
  const rendered = render(failing.length ? "needs-author-update" : det.state);
  return withChecks({ ...rendered, mirror: true, duplicate: false, close: false, confidence, degraded: null, reason }, checks, ctx);
}

export function degradedVerdict(reason: string): RenderOutput {
  return { ...render("stale-unknown"), mirror: false, duplicate: false, close: false, confidence: "unknown", degraded: "error", checks: [], reason, nextAction: "Retry when data is available", actor: "system", feedback: "" };
}

export interface MirrorRequest {
  repo: string;
  number: number;
  labels: string[];
  comment: string;
  close: boolean;
}

export function toMirrorRequest(v: RenderOutput & { repo: string; number: number }): MirrorRequest {
  return {
    repo: v.repo,
    number: v.number,
    labels: v.labels,
    comment: v.feedback,
    close: v.close,
  };
}

export interface BacklogSummary {
  total: number;
  classified: number;
  coverage: string;
  byState: Record<string, number>;
}

export function summarize(results: Array<RenderOutput | null>): BacklogSummary {
  const done = results.filter((r): r is RenderOutput => r !== null);
  const byState: Record<string, number> = {};
  for (const r of done) byState[r.state] = (byState[r.state] ?? 0) + 1;
  return { total: results.length, classified: done.length, coverage: `${done.length}/${results.length}`, byState };
}
