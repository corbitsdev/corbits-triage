import { asRecord } from "@corbits/common";
import { TRIAGE_EVENTS, type TriageEvent } from "./check-pack.js";

export const TRIAGE_STATE_KIND = "corbits.triage.state";
export const TRIAGE_STATE_SCHEMA_VERSION = 1;

/** A pr-triage run still going after this long lost its sidecar: three agent steps on either gate branch of up to fifteen minutes each, plus their retries. */
export const PR_TRIAGE_STUCK_RUN_MS = 90 * 60_000;

/** `stale`: the base branch moved after the head's verdict, so it is due again. `waiting`: its policy reads CI, which is still running on the head. */
export const PR_TRIAGE_STATUSES = ["new", "queued", "running", "triaged", "failed", "stale", "waiting"] as const;
export type PrTriageStatus = (typeof PR_TRIAGE_STATUSES)[number];

/** Timestamps are ISO-8601. */
export type PrTriageRow = {
  number: number;
  headSha: string;
  status: PrTriageStatus;
  runId?: string;
  /** Runs the hub queued for this head; webhook and portal runs do not count. */
  attempts: number;
  /** On a head capped by runs that never started. */
  cappedRetries?: number;
  firstSeenAt: string;
  queuedAt?: string;
  /** Runs started before this do not settle the head: the base branch moved after them. */
  staleBefore?: string;
  updatedAt: string;
  error?: string;
  /** On a waiting head, the events held for the run that starts once CI finishes; on a head the reconciler released from waiting, the events its run was mailed with. */
  events?: TriageEvent[];
};

export type TriageState = {
  kind: typeof TRIAGE_STATE_KIND;
  schemaVersion: typeof TRIAGE_STATE_SCHEMA_VERSION;
  repo: string;
  prs: PrTriageRow[];
};

const STATUS_SET = new Set<string>(PR_TRIAGE_STATUSES);
const EVENT_SET = new Set<string>(TRIAGE_EVENTS);

export function triageStateName(repo: string): string {
  return `triage-state/${repo}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRow(raw: unknown): PrTriageRow | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { number, headSha, status, attempts, firstSeenAt, updatedAt } = row;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  if (typeof headSha !== "string" || headSha.length === 0) return null;
  if (typeof status !== "string" || !STATUS_SET.has(status)) return null;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) return null;
  if (typeof firstSeenAt !== "string" || typeof updatedAt !== "string") return null;
  const cappedRetries = row.cappedRetries;
  if (cappedRetries !== undefined && (typeof cappedRetries !== "number" || !Number.isInteger(cappedRetries) || cappedRetries < 0)) return null;
  const runId = optionalString(row.runId);
  const queuedAt = optionalString(row.queuedAt);
  const staleBefore = optionalString(row.staleBefore);
  const error = optionalString(row.error);
  const events = row.events;
  if (events !== undefined && (!Array.isArray(events) || !events.every((event) => typeof event === "string" && EVENT_SET.has(event)))) return null;
  return {
    number,
    headSha,
    status: status as PrTriageStatus,
    ...(runId !== undefined && { runId }),
    attempts,
    ...(cappedRetries !== undefined && { cappedRetries }),
    firstSeenAt,
    ...(queuedAt !== undefined && { queuedAt }),
    ...(staleBefore !== undefined && { staleBefore }),
    updatedAt,
    ...(error !== undefined && { error }),
    ...(events !== undefined && { events: events as TriageEvent[] }),
  };
}

export function parseTriageState(raw: unknown, repo: string): TriageState | null {
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return null;
  }
  if (!body || body.kind !== TRIAGE_STATE_KIND || body.schemaVersion !== TRIAGE_STATE_SCHEMA_VERSION) return null;
  if (body.repo !== repo || !Array.isArray(body.prs)) return null;
  const prs = body.prs.map(parseRow);
  if (prs.some((row) => row === null)) return null;
  return { kind: TRIAGE_STATE_KIND, schemaVersion: TRIAGE_STATE_SCHEMA_VERSION, repo, prs: prs as PrTriageRow[] };
}
