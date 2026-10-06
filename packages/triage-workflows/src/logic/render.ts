import { render, type Priority, type Rendered, type TriageState, TRIAGE_STATES, PRIORITIES } from "@corbits/rule-packs";
import type { DeterministicResult } from "./checks.js";
import { asText, parseJsonText } from "./extract.js";

export interface Decision {
  state: TriageState;
  priority?: Priority;
  confidence: number;
  reasons: string[];
  route?: string;
  effort?: string;
  worth?: string;
}

export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

function toDecision(d: Partial<Decision> | undefined): Decision | null {
  if (!d || !TRIAGE_STATES.includes(d.state as TriageState) || typeof d.confidence !== "number") return null;
  return {
    ...d,
    state: d.state as TriageState,
    priority: PRIORITIES.includes(d.priority as Priority) ? d.priority : undefined,
    confidence: d.confidence,
    reasons: Array.isArray(d.reasons) ? d.reasons.map(String) : [],
  };
}

interface JevDecision {
  id: string;
  type: string;
  choice?: string;
  confidence?: number;
  noul?: number;
  probabilities?: Record<string, number>;
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

function summary(d: JevDecision) {
  return `${d.id}: ${Object.entries(d.probabilities ?? { [d.choice ?? ""]: d.confidence ?? 0 })
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ")}`;
}

function fromJev(text: string): Decision | null {
  const byId = new Map(jevDecisions(text).map((d) => [d.id, d]));
  const state = byId.get("state");
  const priority = byId.get("priority");
  const route = byId.get("route");
  return toDecision({
    state: state?.choice as TriageState,
    confidence: state?.confidence,
    priority: priority?.choice as Priority,
    route: route?.choice,
    reasons: [
      ...(state ? [`classified as ${String(state.choice)} with confidence ${Number(state.confidence ?? 0).toFixed(2)}${route ? ` (route: ${String(route.choice)})` : ""}`] : []),
      ...[state, priority, route].filter((d): d is JevDecision => d !== undefined).map(summary),
    ],
  });
}

/** Accepts a System One reply (decision lines) or free-text JSON, in that order. */
export function parseDecision(reply: unknown): Decision | null {
  const text = asText(reply);
  const jev = fromJev(text);
  if (jev) return jev;
  const parsed = parseJsonText(text) as (Partial<Decision> & { decision?: Partial<Decision> }) | undefined;
  return toDecision(parsed?.decision ?? parsed);
}

export interface RenderInput {
  author: string;
  det: DeterministicResult;
  decision?: Decision | null;
  confidenceFloor?: number;
}

export interface RenderOutput extends Rendered {
  mirror: boolean;
  duplicate: boolean;
  /** Only a human-confirmed duplicate closes a PR; no automated path sets this. */
  close: boolean;
  confidence: number | "unknown";
  degraded: "inference-outage" | "low-confidence" | "error" | null;
}

export function renderVerdict({ author, det, decision, confidenceFloor = DEFAULT_CONFIDENCE_FLOOR }: RenderInput): RenderOutput {
  if (!det.needsJudgment) {
    const duplicate = det.duplicateOf !== null && det.state === "needs-decision";
    const rendered = render(det.state, { author, reason: det.reason, duplicate });
    return { ...rendered, mirror: det.state !== "stale-unknown", duplicate, close: false, confidence: "unknown", degraded: null };
  }
  if (!decision) {
    return { ...render("needs-decision", { author, reason: det.reason, humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown", degraded: "inference-outage" };
  }
  if (decision.confidence < confidenceFloor) {
    return {
      ...render("needs-decision", { author, reason: `confidence ${decision.confidence} below ${confidenceFloor}`, humanGated: true }),
      mirror: false, duplicate: false, close: false, confidence: decision.confidence, degraded: "low-confidence",
    };
  }
  const reason = decision.reasons[0] ?? det.reason;
  const rendered = render(decision.state, { author, reason, priority: decision.priority });
  return { ...rendered, mirror: true, duplicate: false, close: false, confidence: decision.confidence, degraded: null };
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
