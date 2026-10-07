import { resolveInlineRef, type HubApproval, type PrItem, type RunLog } from "./hub-api.ts";

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "unknown time";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatConfidence(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  return `${Math.round(value * 100)}%`;
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

export type TriageBoardView = "action" | "merge" | "all";

export function priorityRank(priority: string | null): number {
  const rank = priority ? Number(priority.slice(1)) : 4;
  return Number.isFinite(rank) ? rank : 4;
}

export function filterTriageItems(items: PrItem[], view: TriageBoardView): PrItem[] {
  if (view === "action") return items.filter((item) => item.needsHuman || item.state === "new");
  if (view === "merge") return items.filter((item) => item.state === "ready");
  return items;
}

function compareTriageItems(a: PrItem, b: PrItem): number {
  if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1;
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  const aWait = a.waitingSince ? Date.parse(a.waitingSince) : 0;
  const bWait = b.waitingSince ? Date.parse(b.waitingSince) : 0;
  return aWait - bWait;
}

export function sortTriageItems(items: PrItem[]): PrItem[] {
  return [...items].sort(compareTriageItems);
}

export function actionLane(item: PrItem): "p01" | "p2" | "p3" {
  if (item.priority === "P0" || item.priority === "P1") return "p01";
  if (item.priority === "P2") return "p2";
  return "p3";
}

export function prHref(item: Pick<PrItem, "repo" | "number" | "href">): string {
  if (item.number !== null && item.repo.includes("/")) {
    const [owner, name] = item.repo.split("/");
    return `/triage/pr/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${item.number}`;
  }
  return item.href.startsWith("/prs/") ? item.href.replace("/prs/", "/triage/pr/") : item.href;
}
