import { itemText, type CheckItem, type CheckOutput } from "@corbits/triage-contracts";
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

const UNSURE_PREFIX = "Not sure enough of every answer";

/** Why the merge is not recommended; each check shows its own value, so the threshold is named as how sure Triage must be. */
function mergeReasons(merge: MergeVerdict): string[] {
  return merge.reasons.map((reason) => (SCORE_REASON.test(reason) ? `${UNSURE_PREFIX} to recommend merging (needs ${points(merge.threshold)}%)` : reason));
}

/** The merge verdict in one line: ready, or not recommended with the first thing in the way, the threshold last. */
export function mergeText(item: Pick<PrItem, "merge">): string {
  const { merge } = item;
  if (merge === null) return NOT_EVALUATED;
  if (merge.verdict === "ready") return MERGE_LABEL.ready;
  const reasons = mergeReasons(merge);
  const blocker = reasons.find((reason) => !reason.startsWith(UNSURE_PREFIX)) ?? reasons[0];
  if (blocker === undefined) return MERGE_LABEL["not-recommended"];
  return `${MERGE_LABEL["not-recommended"]} · ${lowerFirst(blocker.replace(/^Failed: /, ""))}`;
}

const COUNT = new Intl.NumberFormat("en-US");

function counted(value: number | boolean | string, one: string): string {
  return `${COUNT.format(Number(value))} ${value === 1 ? one : `${one}s`}`;
}

const FACTS: Record<string, (value: number | boolean | string) => string> = {
  isDraft: (value) => (value ? "draft" : "not a draft"),
  status: (value) => (value === "none" ? "no CI" : `CI ${value}`),
  hasConflicts: (value) => (value ? "has conflicts" : "no conflicts"),
  touchesForbiddenPaths: (value) => (value ? "touches forbidden paths" : "no forbidden paths"),
  linkedIssue: (value) => (value ? "issue linked" : "no issue linked"),
  files: (value) => counted(value, "file"),
  lines: (value) => counted(value, "line"),
  approvals: (value) => counted(value, "approval"),
  changesRequested: (value) => counted(value, "change request"),
  holds: (value) => (value ? "holds" : "does not hold"),
};

function fact(name: string, value: number | boolean | string): string {
  return FACTS[name]?.(value) ?? `${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${value}`;
}

function factsText(values: Record<string, number | boolean | string>): string {
  return Object.entries(values).map(([name, value]) => fact(name, value)).join(", ");
}

/** Below its bar a score never shows the bar itself, so the shown number agrees with the check's result. */
function shownScore(score: number, passAt: number): number {
  return score >= passAt ? Math.round(score) : Math.min(Math.round(score), passAt - 1);
}

function scoreText(score: number, passAt: number): string {
  return `${shownScore(score, passAt)} / ${passAt}`;
}

const MAX_LISTED = 3;

function listed(items: readonly CheckItem[]): string {
  const unique = [...new Set(items.map(itemText))];
  const more = unique.length > MAX_LISTED ? ` +${unique.length - MAX_LISTED} more` : "";
  return `${unique.slice(0, MAX_LISTED).join(", ")}${more}`;
}

/** What the check found, as `59 / 70`, `33 files, 2,104 lines`, `20 / 60; couldn't read: src/big.ts` or `couldn't check: file could not be read`; the row shows the check's name, reason and evidence. Null for a verdict from before checks carried output. */
export function checkValueText({ output, reason, evidence }: { output: CheckOutput | null; reason: string | null; evidence: readonly string[] }): string | null {
  if (output === null) return null;
  const behind = output.kind !== "values" && output.kind !== "not-applicable" && output.items?.length && evidence.length === 0 ? ` (${listed(output.items)})` : "";
  switch (output.kind) {
    case "values": return factsText(output.values);
    case "score": return `${scoreText(output.score, output.passAt)}${behind}${output.unread?.length ? `; couldn't read: ${listed(output.unread)}` : ""}`;
    case "met": return `met${behind}`;
    case "not-applicable": return "not applicable";
    case "could-not-check": return `${output.reason === reason ? "couldn't check" : `couldn't check: ${output.reason}`}${behind}`;
  }
}

/** What a check measured, as `9 files, 352 lines` or `Scored 59; couldn't read src/big.ts`; null for an output that is only a state, which the check's reason already says. */
export function checkMeasuredText(output: CheckOutput | null): string | null {
  if (output?.kind === "values") return upperFirst(factsText(output.values));
  if (output?.kind !== "score") return null;
  const unread = output.unread?.length ? `; couldn't read ${listed(output.unread)}` : "";
  return `Scored ${shownScore(output.score, output.passAt)}${unread}`;
}

export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
