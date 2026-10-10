import { resolveInlineRef, type HubApproval, type MergeVerdict, type PrItem, type RunLog } from "./hub-api.ts";

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export { relativeTime } from "./duration.ts";

function points(value: number): number {
  return Math.round(value * 100);
}

const SCORE_REASON = /^Score \S+ is below the threshold \S+$/;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export const MERGE_LABEL: Record<MergeVerdict["verdict"], string> = { ready: "Ready to merge", "not-recommended": "Merge not recommended" };

export const MERGE_SHORT_LABEL: Record<MergeVerdict["verdict"], string> = { ready: "Ready", "not-recommended": "Not ready" };

export const NOT_EVALUATED = "Not evaluated";

/** The weakest model answer against the pack's threshold, in points; rules only when a ready verdict asked no model check, none when no model answered. */
export function mergeScoreText(merge: MergeVerdict): string | null {
  if (merge.score !== null) return `score ${points(merge.score)} (threshold ${points(merge.threshold)})`;
  return merge.verdict === "ready" ? "rules only" : null;
}

/** Why the merge is not recommended, with the score in points like the rest of the portal. */
export function mergeReasons(merge: MergeVerdict): string[] {
  return merge.reasons.map((reason) => (SCORE_REASON.test(reason) && merge.score !== null
    ? `Score ${points(merge.score)} is below the threshold ${points(merge.threshold)}`
    : reason));
}

/** The merge verdict in one line: ready with its score, or not recommended with the first thing in the way, a low score last. */
export function mergeText(item: Pick<PrItem, "merge">): string {
  const { merge } = item;
  if (merge === null) return NOT_EVALUATED;
  if (merge.verdict === "ready") return `${MERGE_LABEL.ready} · ${mergeScoreText(merge)}`;
  const reasons = mergeReasons(merge);
  const blocker = reasons.find((reason) => !reason.startsWith("Score ")) ?? reasons[0];
  if (blocker === undefined) return MERGE_LABEL["not-recommended"];
  return `${MERGE_LABEL["not-recommended"]} · ${lowerFirst(blocker.replace(/^Failed: /, ""))}`;
}

export function approvalHeadline(approval: HubApproval): string {
  const args = obj(approval.toolArguments);
  const repo = typeof args.repo === "string" ? args.repo : null;
  const number = typeof args.number === "number" ? `#${args.number}` : null;
  const target = [repo, number].filter(Boolean).join("");
  if (target && args.close === true) return `An agent wants to post a triage comment and labels, then close ${target}`;
  return target ? `An agent wants to post a triage comment and labels on ${target}` : "An agent is waiting for your approval";
}

type PrRouteParams = {
  id?: string;
  owner?: string;
  repo?: string;
  number?: string;
};

export function findPrItem(items: PrItem[], params: PrRouteParams): PrItem | undefined {
  if (params.owner !== undefined || params.repo !== undefined || params.number !== undefined) {
    if (!params.owner || !params.repo || !params.number) return undefined;
    const number = Number(params.number);
    if (!Number.isInteger(number)) return undefined;
    return items.find((item) => item.repo === `${params.owner}/${params.repo}` && item.number === number);
  }
  if (!params.id) return undefined;
  return items.find((item) => item.pendingApprovalId === params.id || item.runId === params.id || item.key === params.id);
}

const ARG_LABELS: Record<string, string> = {
  repo: "Repository",
  number: "Pull request",
  labels: "Labels",
  comment: "Comment",
  close: "Close pull request",
};

function argLabel(key: string): string {
  if (ARG_LABELS[key]) return ARG_LABELS[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatArgValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) return key === "number" ? `#${value}` : String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatArgValue(key, item)).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .map(formatArgEntry)
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return null;
}

function formatArgEntry([key, value]: [string, unknown]): string | null {
  const formatted = formatArgValue(key, value);
  return formatted === null ? null : `${argLabel(key)}: ${formatted}`;
}

export function argsText(args: Record<string, unknown> | null | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj(args))) {
    const formatted = formatArgValue(key, value);
    if (formatted !== null) pairs.push([argLabel(key), formatted]);
  }
  return pairs;
}

type Ev = RunLog["events"][number];

function eventBody(event: Ev): Record<string, unknown> {
  return obj((event as { body?: unknown }).body);
}

const SCOPED_STEP = /^(.+)\[\d+\]$/;

/** N/M: completed scoped iterations (`step[i]`) over the input array length of the first mapped step. */
export function runCoverage(events: Ev[]): { done: number; total: number } {
  const totals = new Map<string, number>();
  const done = new Map<string, Set<string>>();
  for (const event of events) {
    const body = eventBody(event);
    const stepId = body.stepId;
    if (typeof stepId !== "string") continue;
    const scoped = SCOPED_STEP.exec(stepId);
    if (scoped && (event.type === "StepCompleted" || event.type === "StepFailed")) {
      done.set(scoped[1], (done.get(scoped[1]) ?? new Set()).add(stepId));
    } else if (!scoped && event.type === "StepStarted") {
      const input = resolveInlineRef(obj(body.input).ref);
      if (Array.isArray(input) && !totals.has(stepId)) totals.set(stepId, input.length);
    }
  }
  for (const [stepId, total] of totals) {
    if (done.has(stepId)) return { done: done.get(stepId)!.size, total };
  }
  return { done: 0, total: 0 };
}

function eventTime(event: Ev): number {
  const at = obj(event).at ?? eventBody(event).at ?? eventBody(event).timestamp;
  return typeof at === "string" || typeof at === "number" ? new Date(at).getTime() : NaN;
}

export function runLatencyMs(events: Ev[]): number | null {
  const times = events.map(eventTime).filter((t) => !Number.isNaN(t));
  return times.length < 2 ? null : Math.max(...times) - Math.min(...times);
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "n/a";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function priorityRank(priority: string | null): number {
  const rank = priority ? Number(priority.slice(1)) : 4;
  return Number.isFinite(rank) ? rank : 4;
}

export function prHref(item: Pick<PrItem, "repo" | "number" | "href">): string {
  if (item.number !== null && item.repo.includes("/")) {
    const [owner, name] = item.repo.split("/");
    return `/triage/pr/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${item.number}`;
  }
  return item.href.startsWith("/prs/") ? item.href.replace("/prs/", "/triage/pr/") : item.href;
}
