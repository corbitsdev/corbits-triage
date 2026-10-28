import { asRecord } from "@corbits/common";

export const TRIAGE_STATE_KIND = "corbits.triage.state";
export const TRIAGE_STATE_SCHEMA_VERSION = 1;

/** A pr-triage run still going after this long lost its sidecar: three agent steps on either gate branch of up to fifteen minutes each, plus their retries. */
export const PR_TRIAGE_STUCK_RUN_MS = 90 * 60_000;

/** How long a head waits for its CI, from its first pass that waited for it, before it is decided without it. */
export const CI_WAIT_MS = 60 * 60_000;

/** How long a head with no checks yet waits for its CI to start before it is taken as having none. */
export const CI_START_MS = 2 * 60_000;

/** `stale`: the base branch moved after the head's verdict, so it is due again. */
export const PR_TRIAGE_STATUSES = ["new", "queued", "running", "triaged", "failed", "stale"] as const;
export type PrTriageStatus = (typeof PR_TRIAGE_STATUSES)[number];

/** A queued head's `error` while every provisioner refused its manager for capacity: it waits for a slot, so it is no failure and spends no attempt. */
export const WAITING_FOR_CAPACITY = "waiting for capacity";

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
  /** When the head's mail first did not go out; kept while it is queued again, so it is not taken as newly waiting, until a run of it starts or it settles. */
  undeliveredSince?: string;
  /** Runs started before this do not settle the head: the base branch moved after them. */
  staleBefore?: string;
  updatedAt: string;
  error?: string;
  /** On a failed head whose mail reached no listener: it goes out again as soon as one is up, and those tries add nothing to `attempts`. */
  unrouted?: true;
};

export type TriageState = {
  kind: typeof TRIAGE_STATE_KIND;
  schemaVersion: typeof TRIAGE_STATE_SCHEMA_VERSION;
  repo: string;
  prs: PrTriageRow[];
};

const STATUS_SET = new Set<string>(PR_TRIAGE_STATUSES);

/** A head the hub held for its CI before its manager waited for CI itself was never triaged since, so it reads as new. */
const HELD_FOR_CI = "waiting";

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
  if (typeof status !== "string" || !(STATUS_SET.has(status) || status === HELD_FOR_CI)) return null;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) return null;
  if (typeof firstSeenAt !== "string" || typeof updatedAt !== "string") return null;
  const cappedRetries = row.cappedRetries;
  if (cappedRetries !== undefined && (typeof cappedRetries !== "number" || !Number.isInteger(cappedRetries) || cappedRetries < 0)) return null;
  const runId = optionalString(row.runId);
  const queuedAt = optionalString(row.queuedAt);
  const undeliveredSince = optionalString(row.undeliveredSince);
  const staleBefore = optionalString(row.staleBefore);
  const error = optionalString(row.error);
  return {
    number,
    headSha,
    status: status === HELD_FOR_CI ? "new" : status as PrTriageStatus,
    ...(runId !== undefined && { runId }),
    attempts,
    ...(cappedRetries !== undefined && { cappedRetries }),
    firstSeenAt,
    ...(queuedAt !== undefined && { queuedAt }),
    ...(undeliveredSince !== undefined && { undeliveredSince }),
    ...(staleBefore !== undefined && { staleBefore }),
    updatedAt,
    ...(error !== undefined && { error }),
    ...(row.unrouted === true && { unrouted: true as const }),
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
