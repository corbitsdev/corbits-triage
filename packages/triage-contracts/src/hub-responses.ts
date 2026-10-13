// What the hub's own integration routes answer; the hub describes its routes with these and the portal parses them.
import { type } from "arktype";

const DetailCheck = type({
  "+": "delete",
  check: "string",
  kind: "string",
  result: "string",
  "reason?": "string",
  "evidence?": "string[]",
  /** What the check found, as `CheckOutput`; the portal parses it. */
  "output?": "Record<string, unknown>",
  "gate?": "boolean",
});

const DetailAction = type({
  "+": "delete",
  id: "string",
  "branch?": "string",
  "index?": "number",
  "effectId?": "string",
  "kind?": "string",
  "reason?": "string",
  "target?": "Record<string, unknown>",
  "skipped?": "boolean",
  /** Waiting for a maintainer to approve it. */
  "held?": "boolean",
  /** Set once the run's execute step ran the Do. */
  "status?": "string",
  "error?": "string",
});

/** What the portal shows of a verdict beyond the columns: the verdict's own fields, and the facts it was made from. */
export const VerdictDetail = type({
  "+": "delete",
  /** The head the verdict judged, which its checks' cited lines link into; it can differ from the head its run was asked about. */
  "headSha?": "string | null",
  "priority?": "string | null",
  "owner?": "string | null",
  "nextAction?": "string",
  "score?": "number | null",
  "merge?": { "+": "delete", verdict: "string", score: "number | null", threshold: "number", reasons: "string[]" },
  "reason?": "string",
  /** The verdict's reason, or the rules step's findings when it names none. */
  "evidence?": "string[]",
  "checks?": DetailCheck.array(),
  "labels?": "string[]",
  "feedback?": "string",
  "actions?": DetailAction.array(),
  /** The Do kinds the pr-triage role was granted on the repository when the verdict was made. */
  "automatic?": "string[]",
  "facts?": { "+": "delete", "title?": "string", "author?": "string", "draft?": "boolean", "mergeable?": "boolean | null", "checks?": "string", "reviewAnswered?": "boolean" },
});
export type VerdictDetail = typeof VerdictDetail.infer;

const Verdict = type({
  runId: "string",
  at: "string",
  headSha: "string",
  settled: "boolean",
  state: "string",
  actor: "string",
  humanGated: "boolean",
  degraded: "string | null",
  commented: "boolean",
  checks: type({ check: "string", result: "string" }).array(),
  /** Null on verdicts recorded before it was, whose run log the hub could not read again. */
  detail: VerdictDetail.or("null"),
});

/**
 * The pull request's latest run, when it has not completed: still going, ended early, or running longer than any run can.
 * `unknown` until the hub read the workspace's live logs since it started, when a run may be going unseen.
 */
const Run = type({
  runId: "string",
  startedAt: "string",
  status: "'running' | 'failed' | 'cancelled' | 'stuck'",
}).or({ status: "'unknown'" });

const Pull = type({
  repo: "string",
  number: "number",
  /** When the newest run started by author activity started. */
  activityAt: "string | null",
  verdict: Verdict.or("null"),
  run: Run.or("null"),
});

export const TriageVerdicts = type({
  pulls: Pull.array(),
  /** Connected repositories with any verdict recorded or a run in a live log. */
  triaged: "string[]",
  /** Connected repositories with a verdict in the last 14 days or a run in a live log. */
  active: "string[]",
  /** Whether the decision model scored any verdict. */
  scored: "boolean",
});
export type TriageVerdicts = typeof TriageVerdicts.infer;

const CheckStats = type({ pass: "number", fail: "number", unconfirmed: "number" });
const ActionStats = type({ suggested: "number", executed: "number", failed: "number" });

export const TriageStats = type({
  repo: "string",
  days: "number",
  /** The earliest verdict ever recorded for the repository; later than the window's start, the window is only partly covered. */
  since: "string | null",
  triaged: "number",
  verdicts: "Record<string, number>",
  neededYou: "number",
  checks: type({ "[string]": CheckStats }),
  actions: type({ "[string]": ActionStats }),
  comments: "number",
  medianTimeToVerdictMs: "number | null",
  daily: type({ date: "string", triaged: "number" }).array(),
});
export type TriageStats = typeof TriageStats.infer;

/** The invited principal, and its magic link when the hub sends no email. */
export const InviteSent = type({ principalId: "string", email: "string", emailed: "boolean", "link?": "string" });
export type InviteSent = typeof InviteSent.infer;
/** Roles the caller may invite people into. */
export const InviteRoles = type({ assignableRoleIds: "string[]" });
export type InviteRoles = typeof InviteRoles.infer;

export const SessionList = type({
  sessions: type({ id: "string", userAgent: "string | null", createdAt: "string", expiresAt: "string", isCurrent: "boolean" }).array(),
});
export type SessionList = typeof SessionList.infer;

const PackageVersion = type({ name: "string", version: "string" });

/** Live deployments with the versions each frozen closure pins; `package` is null when it was not deployed from the package registry. */
export const DeployedVersions = type({
  deployments: type({
    id: "string",
    workflow: "string",
    createdAt: "string",
    cancelling: "boolean",
    package: PackageVersion.or("null"),
    tools: PackageVersion.array(),
  }).array(),
});
export type DeployedVersions = typeof DeployedVersions.infer;

/** One thing the workspace recorded; `actor` is a person's email or principal id, `Triage` for the workflow, `hub` for the hub itself, or `unknown`. */
export const AuditEntry = type({ time: "string", actor: "string", action: "string", target: "string", detail: "string" });
export type AuditEntry = typeof AuditEntry.infer;
export const AuditLog = type({ entries: AuditEntry.array() });
export type AuditLog = typeof AuditLog.infer;
