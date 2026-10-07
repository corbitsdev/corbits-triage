import { render, type Rendered } from "@corbits/rule-packs";
import type { DeterministicResult } from "./checks.js";
import { asText } from "./extract.js";
import { failureText, qualityQuestions } from "./quality.js";

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
}

export interface RenderOutput extends Rendered {
  mirror: boolean;
  duplicate: boolean;
  /** Only a human-confirmed duplicate closes a PR; no automated path sets this. */
  close: boolean;
  confidence: number | "unknown";
  degraded: "inference-outage" | "error" | null;
}

export function renderVerdict({ author, det, answers, judgeError }: RenderInput): RenderOutput {
  if (!det.needsJudgment || !det.sources) {
    const duplicate = det.duplicateOf !== null && det.state === "needs-decision";
    const rendered = render(det.state, { author, reason: det.reason, duplicate });
    return { ...rendered, mirror: det.state !== "stale-unknown", duplicate, close: false, confidence: "unknown", degraded: null };
  }
  const sources = det.sources;
  const asked = qualityQuestions(sources).map((q) => q.id);
  const passes = asked.map((id) => answers?.[id]);
  if (judgeError !== undefined || passes.some((p) => p === undefined)) {
    const reason = `decision model unavailable: ${judgeError ?? "no answer"}`;
    return { ...render(det.state, { author, reason, humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown", degraded: "inference-outage" };
  }
  const scores = passes as number[];
  const confidence = Math.round(Math.min(...scores.map((p) => Math.max(p, 1 - p))) * 100) / 100;
  const failing = asked.filter((_, i) => scores[i]! < 0.5);
  const rendered = failing.length
    ? render("needs-author-update", { author, reason: failing.map((id) => failureText(id, sources)).join("; ") })
    : render(det.state, { author, reason: det.reason });
  return { ...rendered, mirror: true, duplicate: false, close: false, confidence, degraded: null };
}

export function degradedVerdict(reason: string, author = ""): RenderOutput {
  return { ...render("stale-unknown", { author, reason }), mirror: false, duplicate: false, close: false, confidence: "unknown", degraded: "error" };
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
