export const TRIAGE_STATE_KIND = "corbits.triage.state";
export const TRIAGE_STATE_SCHEMA_VERSION = 1;
/** Stamped on every verdict; bump it when verdicts change meaning so open pull requests are triaged again. */
export const PR_TRIAGE_WORKFLOW_VERSION = 1;

/** A pr-triage run still going after this long lost its sidecar: four steps of up to fifteen minutes each, plus their retries. */
export const PR_TRIAGE_STUCK_RUN_MS = 90 * 60_000;

export const PR_TRIAGE_STATUSES = ["new", "queued", "running", "triaged", "failed"] as const;
export type PrTriageStatus = (typeof PR_TRIAGE_STATUSES)[number];

/** One open pull request at one head commit. Timestamps are ISO-8601. */
export type PrTriageRow = {
  number: number;
  headSha: string;
  status: PrTriageStatus;
  runId?: string;
  /** Runs the hub queued for this head; webhook and portal runs do not count. */
  attempts: number;
  /** Workflow version the row was created or reset under; absent on rows from before verdicts were stamped. */
  workflowVersion?: number;
  firstSeenAt: string;
  queuedAt?: string;
  updatedAt: string;
  error?: string;
};

export type TriageState = {
  kind: typeof TRIAGE_STATE_KIND;
  schemaVersion: typeof TRIAGE_STATE_SCHEMA_VERSION;
  repo: string;
  prs: PrTriageRow[];
};

const STATUS_SET = new Set<string>(PR_TRIAGE_STATUSES);

export function triageStateName(repo: string): string {
  return `triage-state/${repo}`;
}

export function prTriageKey(repo: string, number: number, headSha: string): string {
  return `${repo}#${number}@${headSha}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
  const workflowVersion = row.workflowVersion;
  if (workflowVersion !== undefined && (typeof workflowVersion !== "number" || !Number.isInteger(workflowVersion))) return null;
  const runId = optionalString(row.runId);
  const queuedAt = optionalString(row.queuedAt);
  const error = optionalString(row.error);
  return {
    number,
    headSha,
    status: status as PrTriageStatus,
    ...(runId !== undefined && { runId }),
    attempts,
    ...(workflowVersion !== undefined && { workflowVersion }),
    firstSeenAt,
    ...(queuedAt !== undefined && { queuedAt }),
    updatedAt,
    ...(error !== undefined && { error }),
  };
}

/** Null when the content is not this repository's triage state. */
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
