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

export type PrFileFact = {
  path: string;
  patch?: string;
  additions?: number;
  deletions?: number;
};

export type PrCommitFact = {
  sha: string;
  message?: string;
  author?: string;
};

export type PrFacts = {
  title?: string;
  author?: string;
  body?: string;
  draft?: boolean;
  mergeable?: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  labels: string[];
  requestedReviewers: string[];
  approvals: string[];
  checks: Array<{ name: string; status: string }>;
  files: PrFileFact[];
  commits: PrCommitFact[];
  comments: Array<{ author?: string; body?: string }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toolNameOf(event: RunLog["events"][number]): string {
  const body = asRecord((event as { body?: unknown }).body);
  const fromBody = body.toolName ?? body.name ?? asRecord(body.tool).name ?? asRecord(body.toolDefinition).name;
  if (typeof fromBody === "string") return fromBody;
  const type = typeof event.type === "string" ? event.type : "";
  return type;
}

function toolOutputOf(event: RunLog["events"][number]): unknown {
  const body = asRecord((event as { body?: unknown }).body);
  const output = body.output ?? body.result ?? body.reply;
  const resolved = resolveInlineRef(asRecord(output).ref);
  if (resolved !== null) return resolved;
  return output;
}

function matchesPr(value: unknown, repo: string, number: number): boolean {
  const record = asRecord(value);
  const facts = asRecord(record.facts);
  const foundRepo = record.repo ?? facts.repo;
  const foundNumber = record.number ?? facts.number ?? record.prNumber ?? facts.prNumber;
  if (foundRepo !== undefined && foundRepo !== repo) return false;
  if (foundNumber !== undefined && Number(foundNumber) !== number) return false;
  return true;
}

function checkFact(row: unknown): PrFacts["checks"][number] {
  const item = asRecord(row);
  return {
    name: typeof item.name === "string" ? item.name : "check",
    status: typeof item.conclusion === "string" ? item.conclusion : typeof item.status === "string" ? item.status : "unknown",
  };
}

function fileFact(row: unknown): PrFileFact {
  const item = asRecord(row);
  return {
    path: typeof item.path === "string" ? item.path : typeof item.filename === "string" ? item.filename : "",
    patch: typeof item.patch === "string" ? item.patch : undefined,
    additions: typeof item.additions === "number" ? item.additions : undefined,
    deletions: typeof item.deletions === "number" ? item.deletions : undefined,
  };
}

function commitFact(row: unknown): PrCommitFact {
  const item = asRecord(row);
  const commit = asRecord(item.commit);
  return {
    sha: typeof item.sha === "string" ? item.sha : "",
    message: typeof item.message === "string" ? item.message : typeof commit.message === "string" ? commit.message : undefined,
    author: typeof item.author === "string" ? item.author : typeof asRecord(commit.author).name === "string" ? String(asRecord(commit.author).name) : undefined,
  };
}

function commentFact(row: unknown): PrFacts["comments"][number] {
  const item = asRecord(row);
  return {
    author: typeof item.author === "string" ? item.author : typeof asRecord(item.user).login === "string" ? String(asRecord(item.user).login) : undefined,
    body: typeof item.body === "string" ? item.body : undefined,
  };
}

export function factsForPr(logs: RunLog[], repo: string, number: number): PrFacts {
  const facts: PrFacts = {
    labels: [],
    requestedReviewers: [],
    approvals: [],
    checks: [],
    files: [],
    commits: [],
    comments: [],
  };
  for (const log of logs) {
    for (const event of log.events) {
      const name = toolNameOf(event);
      const output = toolOutputOf(event);
      if (!matchesPr(asRecord(output).input ?? output, repo, number) && name.startsWith("github_")) {
        const input = asRecord(asRecord((event as { body?: unknown }).body).input);
        if (!matchesPr(input, repo, number) && input.repo !== undefined) continue;
      }
      if (name.includes("github_get_pr")) {
        const pr = asRecord(output);
        if (typeof pr.title === "string") facts.title = pr.title;
        if (typeof pr.author === "string") facts.author = pr.author;
        if (typeof pr.body === "string") facts.body = pr.body;
        if (typeof pr.draft === "boolean") facts.draft = pr.draft;
        if (typeof pr.mergeable === "boolean") facts.mergeable = pr.mergeable;
        if (typeof pr.additions === "number") facts.additions = pr.additions;
        if (typeof pr.deletions === "number") facts.deletions = pr.deletions;
        if (typeof pr.changedFiles === "number") facts.changedFiles = pr.changedFiles;
        if (Array.isArray(pr.labels)) facts.labels = pr.labels.filter((row): row is string => typeof row === "string");
        if (Array.isArray(pr.requestedReviewers)) {
          facts.requestedReviewers = pr.requestedReviewers.filter((row): row is string => typeof row === "string");
        }
      }
      if (name.includes("github_get_reviews")) {
        const reviews = Array.isArray(output) ? output : asRecord(output).reviews;
        if (Array.isArray(reviews)) {
          facts.approvals = reviews
            .map((row) => asRecord(row))
            .filter((row) => String(row.state ?? "").toLowerCase() === "approved")
            .map((row) => (typeof row.user === "string" ? row.user : typeof asRecord(row.user).login === "string" ? String(asRecord(row.user).login) : ""))
            .filter(Boolean);
        }
      }
      if (name.includes("github_get_checks")) {
        const checks = Array.isArray(output) ? output : asRecord(output).check_runs ?? asRecord(output).checks;
        if (Array.isArray(checks)) {
          facts.checks = checks.map(checkFact);
        }
      }
      if (name.includes("github_list_pr_files")) {
        const files = Array.isArray(output) ? output : asRecord(output).files;
        if (Array.isArray(files)) {
          facts.files = files.map(fileFact).filter((row) => row.path.length > 0);
        }
      }
      if (name.includes("github_list_pr_commits")) {
        const commits = Array.isArray(output) ? output : asRecord(output).commits;
        if (Array.isArray(commits)) {
          facts.commits = commits.map(commitFact).filter((row) => row.sha.length > 0);
        }
      }
      if (name.includes("github_list_issue_comments")) {
        const comments = Array.isArray(output) ? output : asRecord(output).comments;
        if (Array.isArray(comments)) {
          facts.comments = comments.map(commentFact);
        }
      }
    }
  }
  return facts;
}
