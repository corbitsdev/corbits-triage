// What the hub's own integration routes answer; the hub describes its routes with these and the portal parses them.
import { type } from "arktype";
import { VERDICTS } from "./check-pack.js";

const VerdictWord = type.enumerated(...VERDICTS);

const DetailCheck = type({
  "+": "delete",
  check: "string",
  kind: "string",
  result: "string",
  "reason?": "string",
  "evidence?": "string[]",
  "output?": "Record<string, unknown>",
  /** Marks an author rule, on verdicts recorded before author rules were removed. */
  "gate?": "boolean",
});

const DetailAction = type({
  "+": "delete",
  "list?": VerdictWord,
  "index?": "number",
  "effectId?": "string",
  "kind?": "string",
  "reason?": "string",
  "target?": "Record<string, unknown>",
  "skipped?": "boolean",
  "held?": "boolean",
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
  "verdict?": VerdictWord,
  "score?": "number | null",
  "reasons?": "string[]",
  "reason?": "string",
  "evidence?": "string[]",
  "checks?": DetailCheck.array(),
  "labels?": "string[]",
  "feedback?": "string",
  "actions?": DetailAction.array(),
  "automatic?": "string[]",
  "facts?": { "+": "delete", "title?": "string", "author?": "string", "draft?": "boolean", "mergeable?": "boolean | null", "checks?": "string", "reviewAnswered?": "boolean" },
});
export type VerdictDetail = typeof VerdictDetail.infer;

const Verdict = type({
  runId: "string",
  at: "string",
  headSha: "string",
  /** Read from the state of verdicts recorded before verdicts were words. */
  verdict: VerdictWord,
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
  triaged: "string[]",
  /** Connected repositories with a verdict in the last 14 days or a run in a live log. */
  active: "string[]",
  scored: "boolean",
});
export type TriageVerdicts = typeof TriageVerdicts.infer;

const CheckStats = type({ pass: "number", fail: "number", unconfirmed: "number", "levels?": "Record<string, number>" });
const ActionStats = type({ suggested: "number", executed: "number", failed: "number" });

/** Medians over `prs` pull requests, `closed` of them merged or closed; times are from opening, the gap is the longest wait between two people's touches, the author's included. */
export const OutcomeMedians = type({
  prs: "number",
  closed: "number",
  mergeOrCloseMs: "number | null",
  firstHumanResponseMs: "number | null",
  firstApprovalMs: "number | null",
  humanTouchGapMs: "number | null",
});
export type OutcomeMedians = typeof OutcomeMedians.infer;

/** Why the baseline is missing: no saved policy marks when triage began, or the host did not answer. */
export const BaselineState = type("'measured' | 'no_policy' | 'source_failed'");
export type BaselineState = typeof BaselineState.infer;

/**
 * Pull requests triaged in the window against those closed before `baselineBefore`, when the repository's policy was
 * first saved; a measured baseline is null when none closed before. `measuring` is before the first read finished; any
 * other state means nothing could be read.
 */
export const TriageOutcomes = type({
  state: "'measured'",
  triaged: OutcomeMedians,
  baseline: OutcomeMedians.or("null"),
  baselineBefore: "string | null",
  baselineState: BaselineState,
}).or({ state: "'measuring' | 'no_credential' | 'source_failed'" });
export type TriageOutcomes = typeof TriageOutcomes.infer;

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
  daily: type({ date: "string", triaged: "number" }).array(),
  /** Null when the hub reads no host for the repository. */
  outcomes: TriageOutcomes.or("null"),
});
export type TriageStats = typeof TriageStats.infer;

export const InviteSent = type({ principalId: "string", email: "string", emailed: "boolean", "link?": "string" });
export type InviteSent = typeof InviteSent.infer;
/** Only whether the allowlist names single addresses, which stay private. `null` when anyone may sign in. */
export const InviteRoles = type({
  assignableRoleIds: "string[]",
  sendsEmail: "boolean",
  signInLimit: type({ domains: "string[]", addresses: "boolean" }).or("null"),
});
export type InviteRoles = typeof InviteRoles.infer;

export const SessionList = type({
  sessions: type({ id: "string", userAgent: "string | null", createdAt: "string", expiresAt: "string", isCurrent: "boolean" }).array(),
});
export type SessionList = typeof SessionList.infer;

const PackageVersion = type({ name: "string", version: "string" });

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

const ArtifactRefShape = type({ id: "string", version: "number" });

/**
 * The repository's policy file on its default branch. `syncedAt` is when the hub's copy was last read from the file,
 * `inSync` whether the hub's copy holds what the file does, and `problem` why the file cannot be used.
 */
export const PolicyFileStatus = type({ path: "string", sha: "string", url: "string", "syncedAt?": "string", inSync: "boolean", "problem?": "string" });
export type PolicyFileStatus = typeof PolicyFileStatus.infer;

const FileRefShape = type({ path: "string", sha: "string" });

export const PolicySourceShape = type({ repo: ArtifactRefShape, "shared?": ArtifactRefShape, "file?": FileRefShape });

export const PolicyRead = type({ status: "'ok'", pack: "Record<string, unknown>", source: PolicySourceShape })
  .or({ status: "'missing'" })
  .or({ status: "'corrupt'", reason: "string", repo: ArtifactRefShape });

/** Read apart from the policy because it asks GitHub, which the repositories table must not do for every repository. */
export const PolicyFileRead = type({ file: PolicyFileStatus.or("null") });
export type PolicyFileRead = typeof PolicyFileRead.infer;

export const PolicySynced = type({ status: "'synced' | 'unchanged'", sha: "string" });
export type PolicySynced = typeof PolicySynced.infer;

export const PolicyExported = type({ status: "'opened'", url: "string", number: "number" });
export type PolicyExported = typeof PolicyExported.infer;

export const BacklogStarted = type({ status: "'started'" });
