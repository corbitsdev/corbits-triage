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

/**
 * The pull request's latest run, when it has not completed: still going, ended early, or running longer than any run can.
 * `waiting-ci`: no run yet, as the policy reads CI and it is still running on `headSha`, seen `since`.
 */
const Run = type({
  runId: "string",
  startedAt: "string",
  status: "'running' | 'failed' | 'cancelled' | 'stuck'",
})
  .or({ status: "'waiting-ci'", since: "string", headSha: "string" });

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

const ArtifactRefShape = type({ id: "string", version: "number" });

/** The repository's policy file on its default branch; `problem` is why triage does not run on it. */
export const PolicyFileStatus = type({ path: "string", sha: "string", url: "string", "problem?": "string" });
export type PolicyFileStatus = typeof PolicyFileStatus.infer;

const FileRefShape = type({ path: "string", sha: "string" });

export const PolicySourceShape = type({ "repo?": ArtifactRefShape, "shared?": ArtifactRefShape, "file?": FileRefShape, "sharedFile?": FileRefShape.and({ repo: "string" }) });

const ActionKinds = type.enumerated(...ACTION_KINDS).array();

/** What an automatic approve or merge can let in: pull requests from first-time contributors, or changes to CI workflows. */
export const MERGE_RISKS = ["first-timers", "ci-config"] as const;
export type MergeRisk = (typeof MERGE_RISKS)[number];

/**
 * `automatic` is what Triage may do on its own in the repository; `decide` the action kinds the policy file's own
 * `decide` names; `mergeRisks` what Triage's automatic approve or merge can let in. `invalid` is a policy file triage
 * refuses, so nothing runs until it is fixed.
 */
export const PolicyRead = type({ status: "'ok'", pack: "Record<string, unknown>", source: PolicySourceShape, automatic: ActionKinds, decide: ActionKinds, mergeRisks: type.enumerated(...MERGE_RISKS).array() })
  .or({ status: "'missing'" })
  .or({ status: "'corrupt'", reason: "string", repo: ArtifactRefShape })
  .or({ status: "'invalid'", reason: "string", path: "string" });

/** Read apart from the policy because it asks GitHub, which the repositories table must not do for every repository. */
export const PolicyFileRead = type({ file: PolicyFileStatus.or("null") });
export type PolicyFileRead = typeof PolicyFileRead.infer;

const PolicyProblem = type({ message: "string", "line?": "number", "column?": "number" });

export const PolicyValidated = type({ ok: "true", policy: "Record<string, unknown>", workflow: policyWorkflowSchema }).or({ ok: "false", problems: PolicyProblem.array() });
export type PolicyValidated = typeof PolicyValidated.infer;

/** `headSha`: the GitHub pull request's head, which a merge from the portal pins; a Bitbucket one is merged there. */
const PolicyPull = type({ url: "string", number: "number", "headSha?": "string" });

export const PolicyExported = type({ status: "'opened'" }).and(PolicyPull);
export type PolicyExported = typeof PolicyExported.infer;

/** A policy patch pull request. `state` is open: this route never merges. `PolicyExported` stays without it. */
export const PolicyPatched = type({ status: "'opened'", state: "'open'" }).and(PolicyPull);
export type PolicyPatched = typeof PolicyPatched.infer;

/** No diff library is a dependency, so a preview is the file before the patch and the patched file. */
export const PolicyPatchPreview = type({ before: "string", after: "string" });
export type PolicyPatchPreview = typeof PolicyPatchPreview.infer;

export const PolicyPatchResponse = PolicyPatchPreview.or(PolicyPatched);
export type PolicyPatchResponse = typeof PolicyPatchResponse.infer;

/**
 * One way the file's policy runs differently from the saved one: the rule or step list, its values in each (empty is
 * off or nothing), and in plain words what changes if the file is used instead.
 */
export const PolicyDifference = type({ rule: "string", saved: "string[]", file: "string[]", instead: "string" });
export type PolicyDifference = typeof PolicyDifference.infer;

/**
 * How a repository's saved rules stand against its policy file. `start`: neither. `upgrade`: saved rules and no file.
 * `differs`: both, and they run differently, or triage refuses the file at `path` for `problem`; the saved rules apply
 * until the file matches them or the saved artifact is archived; `fixable` is false when writing the saved rules to the
 * file would change nothing it does, because the rest is what a file cannot hold. `unexpressed` lists what the saved
 * rules hold that a policy file cannot.
 */
export const PolicyUpgrade = type({ state: "'ok'" })
  .or({ state: "'start'" })
  .or({ state: "'upgrade'", saved: ArtifactRefShape, unexpressed: "string[]" })
  .or({ state: "'differs'", path: "string", saved: ArtifactRefShape, differences: PolicyDifference.array(), "problem?": "string", fixable: "boolean", unexpressed: "string[]" });
export type PolicyUpgrade = typeof PolicyUpgrade.infer;

/** Each enabled repository the member may read; `pull` is the open pull request writing the saved rules to the file, `error` why the repository could not be read. */
export const PolicyUpgrades = type({ repos: type({ repo: "string", source: type.enumerated(...REPO_SOURCES), "upgrade?": PolicyUpgrade, "pull?": PolicyPull, "error?": "string" }).array() });
export type PolicyUpgrades = typeof PolicyUpgrades.infer;

export const BacklogStarted = type({ status: "'started'" });
