// What the hub's own integration routes answer; the hub describes its routes with these and the portal parses them.
import { type } from "arktype";
import { ACTION_KINDS, VERDICTS } from "./check-pack.js";
import { policyWorkflowSchema } from "./policy-workflow.js";
import { REPO_SOURCES } from "./repo-source.js";

/** The most pull requests one merge-states read asks about. */
export const MAX_MERGE_STATES = 100;

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
  /** The head's CI state that alone holds or skips it; while `pending`, the run after CI finishes decides it again. */
  "ci?": "'pending' | 'failure' | 'cancelled' | 'none'",
  "status?": "string",
  "error?": "string",
});

/** The pull request's facts a verdict keeps. */
export const VerdictFacts = type({ "+": "delete", "title?": "string", "author?": "string", "draft?": "boolean", "mergeable?": "boolean | null", "checks?": "string", "reviewAnswered?": "boolean" });

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
  /** Why the run's mirror posted nothing on the host: `stale`, `waiting`, `no_request` or `no_grants`. */
  "notPosted?": "string",
  /** Why the policy's `for` or `when` left the head out of code review. */
  "codeReviewSkipped?": "string",
  "facts?": VerdictFacts,
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

/** What a manager waits on between passes, in the order it asks them: the judge for the judgement rules, then code review. */
export const AWAITED_STAGES = ["judge", "code-review"] as const;
export type AwaitedStage = (typeof AWAITED_STAGES)[number];

/**
 * The pull request's latest run, when it has not completed: still going, ended early, or running longer than any run can.
 * `waiting-ci`: the pull request's manager waits for CI still running on `headSha`, since `since`, before it decides.
 * `awaiting`: the manager is up between passes and posts once each of `on` has reported on the newest head.
 */
const Run = type({
  runId: "string",
  startedAt: "string",
  status: "'running' | 'failed' | 'cancelled' | 'stuck'",
})
  .or({ status: "'waiting-ci'", since: "string", headSha: "string" })
  .or({ runId: "string", status: "'awaiting'", on: type.enumerated(...AWAITED_STAGES).array().atLeastLength(1) });

const Source = type.enumerated(...REPO_SOURCES);

const HostedRepo = type({ repo: "string", source: Source });

const Pull = type({
  repo: "string",
  number: "number",
  /** The host the pull request is on. */
  source: Source,
  /** When the newest run started by author activity started. */
  activityAt: "string | null",
  verdict: Verdict.or("null"),
  run: Run.or("null"),
  /** Why this pull request has no verdict, in words for a person. Absent once a verdict exists, or when the hub has nothing to say. */
  "untriaged?": "string",
});

export const TriageVerdicts = type({
  pulls: Pull.array(),
  triaged: HostedRepo.array(),
  /** Connected repositories with a verdict in the last 14 days or a run in a live log, each on its host. */
  active: HostedRepo.array(),
  scored: "boolean",
});
export type TriageVerdicts = typeof TriageVerdicts.infer;

const CheckStats = type({ pass: "number", fail: "number", unconfirmed: "number", "levels?": "Record<string, number>" });
const ActionStats = type({ suggested: "number", executed: "number", failed: "number" });

/**
 * Times from opening; the gap is the longest wait between two people's touches, the author's included. The reviewer
 * wait is from Triage's first verdict to the first review or merge by someone other than the author.
 */
export const OutcomeTimes = type({
  mergeOrCloseMs: "number | null",
  firstHumanResponseMs: "number | null",
  firstApprovalMs: "number | null",
  humanTouchGapMs: "number | null",
  reviewerWaitMs: "number | null",
});
export type OutcomeTimes = typeof OutcomeTimes.infer;

/** Medians, and the 75th percentile in `p75`, over `prs` pull requests, `closed` of them merged or closed. */
export const OutcomeMedians = OutcomeTimes.merge({ prs: "number", closed: "number", p75: OutcomeTimes });
export type OutcomeMedians = typeof OutcomeMedians.infer;

/** Why the baseline is missing: no verdict yet marks when triage began, or the host did not answer. */
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
  /** Distinct people, bots excluded, who commented, reviewed, merged or closed the triaged pull requests. */
  humans: "number",
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
  /** On a hub that sends no email, people, members or invited, who signed up with email and password and have not verified it. */
  unverifiedPrincipalIds: "string[]",
  /** The caller is the hub's owner, its first account, on a hub that sends no email, so may mark those addresses verified. */
  canMarkVerified: "boolean",
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
    /** Up as the hub counts a listener or a manager: running, on its sidecar, or just deployed. */
    live: "boolean",
    package: PackageVersion.or("null"),
    /** The packages its frozen closure carries besides the workflow; absent without a closure. */
    "tools?": PackageVersion.array(),
    /** The source asset commit a source-format deployment runs, so it can be deployed again as it is. */
    source: type({ assetId: "string", commitSha: "string" }).or("null"),
  }).array(),
  /** Each host the hub rolled since it started: when the roll ended, and why it failed if it did; the listener before it keeps running. */
  rollouts: type({ source: type.enumerated(...REPO_SOURCES), at: "string", "error?": "string" }).array(),
  /**
   * The hub's local sidecar, across workspaces: deployments and probes it runs (`active`) out of `cap`, deployments
   * placed there that wait for a free slot (`waiting`), and deployments that could have run there but run on a sandbox
   * because it was full (`overflow`).
   */
  sidecar: type({ active: "number", waiting: "number", cap: "number", overflow: "number" }),
  /** Each host whose pull requests have waited for a manager past the hub's alarm age: since when the oldest waits, and when a manager of that host last took one. */
  "stalled?": type({ source: type.enumerated(...REPO_SOURCES), since: "string", "lastTakeAt?": "string" }).array(),
});
export type DeployedVersions = typeof DeployedVersions.infer;

/** A place code review can run, as a provisioner package describes it: `env` holds the `.env` lines that set it up, `guide` its setup guide. */
export const PlaceGuide = type({ id: "string", label: "string", why: "string", env: "string[]", guide: "string" });
export type PlaceGuide = typeof PlaceGuide.infer;

/** `active`: code review runs here. `ready`: registered, but another is first. `failing`: set up, but the hub could not register it, for `reason`. */
export const CodeReviewPlaceOption = PlaceGuide.and({ state: "'active' | 'ready' | 'not_set_up' | 'failing'", "reason?": "string" });
export type CodeReviewPlaceOption = typeof CodeReviewPlaceOption.infer;

/** The provisioner the workspace's code review deploys to, null when none can run it, and every place this hub knows. */
export const CodeReviewPlace = type({ provisioner: "string | null", places: CodeReviewPlaceOption.array() });
export type CodeReviewPlace = typeof CodeReviewPlace.infer;

/** One thing the workspace recorded; `actor` is a person's email or principal id, `Triage` for the workflow, `hub` for the hub itself, or `unknown`. */
export const AuditEntry = type({ time: "string", actor: "string", action: "string", target: "string", detail: "string" });
export type AuditEntry = typeof AuditEntry.infer;
export const AuditLog = type({ entries: AuditEntry.array() });
export type AuditLog = typeof AuditLog.infer;

/**
 * The repository's policy file on its default branch; `text` is absent when it is too large to read, `problem` is why
 * triage does not run on it. `pull` is the open policy pull request's copy of the file at its head `headSha`;
 * `pullUnread` that the policy branch could not be listed or read, so whether it holds a copy is not known.
 */
export const PolicyFileStatus = type({ path: "string", sha: "string", url: "string", "text?": "string", "problem?": "string", "pending?": "string", "pull?": { text: "string", headSha: "string" }, "pullUnread?": "true" });
export type PolicyFileStatus = typeof PolicyFileStatus.infer;

const FileRefShape = type({ path: "string", sha: "string" });

export const PolicySourceShape = type({ "file?": FileRefShape, "sharedFile?": FileRefShape.and({ repo: "string" }) });

const ActionKinds = type.enumerated(...ACTION_KINDS).array();

/** What an automatic approve or merge can let in: pull requests from first-time contributors, or changes to CI workflows. */
export const MERGE_RISKS = ["first-timers", "ci-config"] as const;
export type MergeRisk = (typeof MERGE_RISKS)[number];

/**
 * `automatic` is what Triage may do on its own in the repository; `wanted` every action kind the policy has
 * Triage do unattended on the host, which is what the role is granted under `policy` automation; `mergeRisks` what Triage's automatic approve or
 * merge can let in; `codeReview` whether the policy file turns code review on. `invalid` is a policy file triage
 * refuses, so nothing runs until it is fixed.
 */
export const PolicyRead = type({ status: "'ok'", pack: "Record<string, unknown>", source: PolicySourceShape, automatic: ActionKinds, wanted: ActionKinds, mergeRisks: type.enumerated(...MERGE_RISKS).array(), codeReview: "boolean" })
  .or({ status: "'missing'" })
  .or({ status: "'invalid'", reason: "string", path: "string" });

/** What Triage does on its own in the repository once a kind is allowed there. */
export const TriageAutomated = type({ automatic: ActionKinds });

/** Read apart from the policy because it asks GitHub, which the repositories table must not do for every repository. */
export const PolicyFileRead = type({ file: PolicyFileStatus.or("null") });
export type PolicyFileRead = typeof PolicyFileRead.infer;

const PolicyProblem = type({ message: "string", "line?": "number", "column?": "number" });

export const PolicyValidated = type({ ok: "true", policy: "Record<string, unknown>", workflow: policyWorkflowSchema, "pending?": PolicyProblem.array() }).or({ ok: "false", problems: PolicyProblem.array() });
export type PolicyValidated = typeof PolicyValidated.infer;

/** `headSha`: the GitHub pull request's head, which a merge from the portal pins; a Bitbucket one is merged there. */
const PolicyPull = type({ url: "string", number: "number", "headSha?": "string" });

export const PolicyExported = type({ status: "'opened'" }).and(PolicyPull);
export type PolicyExported = typeof PolicyExported.infer;

/** No diff library is a dependency, so a preview is the file before the patch and the patched file. */
export const PolicyPatchPreview = type({ before: "string", after: "string" });
export type PolicyPatchPreview = typeof PolicyPatchPreview.infer;

export const PolicyPatchResponse = PolicyPatchPreview.or(PolicyExported);
export type PolicyPatchResponse = typeof PolicyPatchResponse.infer;

/** `start`: the repository has no policy file, so triage runs nothing in it; `ok`: it has one. */
export const PolicyUpgrade = type({ state: "'ok'" }).or({ state: "'start'" });
export type PolicyUpgrade = typeof PolicyUpgrade.infer;

/** Whether the hub may push the policy file straight to `branch`, the default branch; `reason` says why not. */
export const PolicyPushAccess = type({ branch: "string", allowed: "true" }).or({ branch: "string", allowed: "false", reason: "string" });
export type PolicyPushAccess = typeof PolicyPushAccess.infer;

/** The pushed file's `sha`, as the next read of it answers, and the commit that wrote it. */
export const PolicyPushed = type({ status: "'pushed'", path: "string", sha: "string", commit: "string" });
export type PolicyPushed = typeof PolicyPushed.infer;

/**
 * Each enabled repository the member may read; `pull` is its open policy pull request, with or without a policy file,
 * `pullUnread` that its open pull requests could not be listed, so whether one is open is not known, and `error` why the
 * repository could not be read.
 */
export const PolicyUpgrades = type({ repos: type({ repo: "string", source: type.enumerated(...REPO_SOURCES), "upgrade?": PolicyUpgrade, "pull?": PolicyPull, "pullUnread?": "true", "error?": "string" }).array() });
export type PolicyUpgrades = typeof PolicyUpgrades.infer;

export const BacklogStarted = type({ status: "'started'" });
