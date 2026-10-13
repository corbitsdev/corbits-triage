import type { SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Judged } from "@corbits/triage-workflows/logic/item";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import type { RateLimit } from "./github-public.ts";
import type { PageAction } from "./page-actions.ts";
import type { PrRef } from "./pr.ts";

/** How one run read GitHub: requests to github.com as the signed-in person, and calls to api.github.com. */
export type ReadCounts = { session: number; api: number };

export type ViewCheck = Omit<CheckResult, "result"> & { name: string; result: CheckResult["result"] | "needs-judge" };

/** A file a failing rule check points at, for a marker on the Files tab; `line` is the added line it found, in the new file. */
export type FileNote = { path: string; line?: number; check: string; reason: string };

/** One triage of one head as the panel and chip show it, made in this browser. */
export type TriageView = {
  pr: PrRef;
  title: string;
  author: string;
  headSha: string;
  ranAt: string;
  /** When GitHub last confirmed this head is still the pull request's, so it was not scored again. */
  checkedAt?: string;
  /** Whether the decision model was asked: not needed when the pack has no model checks, not run without a key. */
  judge: "not-needed" | "not-run" | "asked";
  /** The decision model's answers a later run of this head can reuse, and the model that gave them. */
  judged?: Judged;
  judgedBy?: string;
  verdict: Pick<Verdict, "state" | "reason" | "nextAction" | "actor" | "feedback" | "verdict" | "score" | "reasons" | "degraded">;
  /** 0 to 100, the hub's readiness: pass counts 1, unconfirmed half and fail 0; null when there are no checks or the verdict is degraded. */
  readiness: number | null;
  checks: ViewCheck[];
  /** The Dos this verdict suggests, in pack order. */
  dos: SuggestedDo[];
  /** Dos that depend on the verdict the decision model has not given, so they suggest nothing until it does. */
  waitingOnJudge: number;
  /** GitHub's API limit after a local run's reads, when any went to the API. */
  rate?: RateLimit;
  /** How a local run read GitHub. */
  reads?: ReadCounts;
  /** Steps the failing checks of a local run point to, besides the pack's Dos. */
  suggested?: PageAction[];
  /** Files the failing checks of a local run point at. */
  notes?: FileNote[];
  /** Whether the pull request is a draft, as a local run read it. */
  draft?: boolean;
  /** How a pull request that is no longer open ended: it has a score, and nothing left to do. */
  ended?: Ended;
};

export type Ended = "merged" | "closed";

/** A pull request opened again within this long reuses its run without asking GitHub whether its head moved. */
export const FRESH_MS = 10 * 60 * 1000;

const READINESS: Record<ViewCheck["result"], number> = { pass: 1, unconfirmed: 0.5, "needs-judge": 0.5, fail: 0 };

/** The hub's triage-timeline readiness, over the same checks. */
export function readinessOf(checks: ReadonlyArray<Pick<ViewCheck, "result">>, degraded: Verdict["degraded"]): number | null {
  if (degraded !== null || checks.length === 0) return null;
  return Math.round((checks.reduce((sum, check) => sum + READINESS[check.result], 0) / checks.length) * 100);
}

const STATE_NAMES: Record<Verdict["state"], string> = {
  "needs-decision": "Needs a decision",
  "awaiting-review": "Awaiting review",
  "needs-author-update": "Needs author update",
  blocked: "Blocked",
  "ready-monitoring": "Ready",
  "stale-unknown": "Unknown",
};

export type Tone = "ready" | "waiting" | "attention" | "unknown" | Ended;

/** How each state reads at a glance: ready, waiting on someone else, needing the author or a decision, or unknown. */
const TONES: Record<Verdict["state"], Tone> = {
  "ready-monitoring": "ready",
  "awaiting-review": "waiting",
  "needs-author-update": "attention",
  blocked: "attention",
  "needs-decision": "attention",
  "stale-unknown": "unknown",
};

const ENDED_NAMES: Record<Ended, string> = { merged: "Merged", closed: "Closed" };

/** The state a person reads: how the pull request ended, or its triage state while it is open. */
export function stateName(view: TriageView): string {
  return view.ended ? ENDED_NAMES[view.ended] : STATE_NAMES[view.verdict.state];
}

export function toneOf(view: TriageView): Tone {
  return view.ended ?? TONES[view.verdict.state];
}

/** What to do next; a pull request that ended has nothing, so it says the score it had. */
export function nextStep(view: TriageView): string {
  if (!view.ended) return view.verdict.nextAction;
  return view.readiness === null ? "Nothing left to do." : `Scored ${view.readiness}. Nothing left to do.`;
}
