// A pull request's readiness history, from the recorded verdicts only: one
// entry per verdict that changed the head or a check result, with the checks
// that changed since the judged verdict before it. The portal merges in the
// pull request's Do runs, which it already reads from the github-dos route.
import { type } from "arktype";
import { failure, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import type { RecordedCheck, VerdictRecord, VerdictRecordStore } from "./verdict-record-store.js";

export const TRIAGE_TIMELINE_PATH = "/api/integrations/triage-timeline";

const TimelineQuery = type({
  repo: /^[\w.-]+\/[\w.-]+$/,
  number: type("string.integer.parse").to("1 <= number.integer <= 2147483647"),
});

const SCORE = new Map([["pass", 1], ["unconfirmed", 0.5], ["fail", 0]]);

const CheckChange = type({ check: "string", from: "string | null", to: "string | null" });
type CheckChange = typeof CheckChange.infer;

const TimelineEntry = type({
  at: "string",
  runId: "string",
  headSha: "string",
  state: "string",
  actor: "string",
  /** False while the verdict waits on something, such as a check GitHub had not computed yet. */
  settled: "boolean",
  degraded: "string | null",
  /** 0–100: pass counts 1, unconfirmed half and fail 0 over the verdict's checks; null when it has none or is degraded. */
  readiness: "number | null",
  changed: CheckChange.array(),
});
type TimelineEntry = typeof TimelineEntry.infer;

export const TriageTimeline = type({ repo: "string", number: "number", entries: TimelineEntry.array() });
export type TriageTimeline = typeof TriageTimeline.infer;

export type TriageTimelineDeps = PortalCredentialDeps & {
  verdicts: Pick<VerdictRecordStore, "forPull">;
};

function readiness(checks: readonly RecordedCheck[]): number | null {
  const scores = checks.flatMap((c) => SCORE.get(c.result) ?? []);
  if (scores.length === 0) return null;
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100);
}

function changes(previous: readonly RecordedCheck[] | undefined, current: readonly RecordedCheck[]): CheckChange[] {
  if (!previous) return [];
  const before = new Map(previous.map((c) => [c.check, c.result]));
  const after = new Map(current.map((c) => [c.check, c.result]));
  const checks = new Set([...before.keys(), ...after.keys()]);
  return [...checks].flatMap(function changed(check) {
    const from = before.get(check) ?? null;
    const to = after.get(check) ?? null;
    return from === to ? [] : [{ check, from, to }];
  });
}

function sameOutcome(a: VerdictRecord, b: VerdictRecord): boolean {
  return a.headSha === b.headSha && a.settled === b.settled && a.degraded === b.degraded && changes(a.checks, b.checks).length === 0;
}

/** `records` is oldest first. Degraded verdicts judged nothing, so they neither score nor serve as the baseline for the next change. */
function timeline(records: readonly VerdictRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let kept: VerdictRecord | undefined;
  let judged: readonly RecordedCheck[] | undefined;
  for (const verdict of records) {
    if (kept && sameOutcome(kept, verdict)) continue;
    kept = verdict;
    const scored = verdict.degraded === null;
    entries.push({
      at: verdict.verdictAt.toISOString(),
      runId: verdict.runId,
      headSha: verdict.headSha,
      state: verdict.state,
      actor: verdict.actor,
      settled: verdict.settled,
      degraded: verdict.degraded,
      readiness: scored ? readiness(verdict.checks) : null,
      changed: scored ? changes(judged, verdict.checks) : [],
    });
    if (scored) judged = verdict.checks;
  }
  return entries;
}

export function createTriageTimeline(deps: TriageTimelineDeps) {
  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const url = new URL(req.url);
    const query = TimelineQuery({ repo: url.searchParams.get("repo"), number: url.searchParams.get("number") });
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const { repo, number } = query;
    const entries = timeline(await deps.verdicts.forPull(tenantId, repo, number));
    return Response.json({ repo, number, entries } satisfies TriageTimeline);
  };
}
