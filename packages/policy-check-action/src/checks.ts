import { classificationSources, DEFAULT_REPO_POLICY, isModelCheck, parseCheckPack, stockTriggerMail, type CheckPack } from "@corbits/triage-contracts";
import { PR_TRIAGE, recordingGithub } from "@corbits/triage-workflows/evals/run-definition";
import { runLocalWorkflow } from "@corbits/triage-workflows/evals/run-local";
import { hardFailures, type CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import type { WorkflowAuthorizeFn } from "@intx/workflow";

interface PullRequest {
  repo: string;
  number: number;
  headSha: string;
}

/** What one run of the checks says: annotation and summary lines, and whether a rule whose failure means Fail failed. */
interface Report {
  annotations: string[];
  summary: string[];
  failed: boolean;
}

// Workflow command escaping as in https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
export function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

function noModel(): never {
  throw new Error("model checks are skipped, so no step may call a model");
}

/** The pack less every rule a model answers, and those rules' ids. */
function withoutModelChecks(pack: CheckPack): { pack: CheckPack; skipped: string[] } {
  const { quality, custom } = classificationSources(pack);
  const off = Object.fromEntries(quality.map(({ id }) => [id, { ...pack.checks[id], enabled: false }]));
  return {
    pack: { ...pack, checks: { ...pack.checks, ...off }, custom: pack.custom.filter((row) => !isModelCheck(row)) },
    skipped: [...quality.map(({ id }) => id), ...custom.map(({ id }) => id)],
  };
}

function level(check: CheckResult, hard: readonly CheckResult[]): string {
  if (hard.includes(check)) return "error";
  return check.onFail === "ask" ? "warning" : "notice";
}

function annotation(check: CheckResult, hard: readonly CheckResult[]): string {
  return `::${level(check, hard)} title=${escapeProperty(check.check)}::${escapeData([check.reason, ...check.evidence].join("\n"))}`;
}

function row(check: CheckResult): string {
  return `| ${check.check} | ${check.result} | ${check.reason.replaceAll("|", "\\|")} |`;
}

/**
 * Runs the policy's rules that need no model against the pull request through the pr-triage definition, with GitHub's
 * reads served by `read` and every write recorded and dropped.
 */
export async function runChecks(policy: Record<string, unknown>, pr: PullRequest, read: (url: URL, init?: RequestInit) => Promise<Response>): Promise<Report> {
  const parsed = parseCheckPack(policy, pr.repo);
  if (!parsed) throw new Error("the policy is not a check pack");
  const { pack, skipped } = withoutModelChecks(parsed);
  const run = await runLocalWorkflow({
    ...PR_TRIAGE,
    authorize: allow,
    github: recordingGithub(read, []),
    inference: { credentialId: "none", origin: "https://model.invalid", apiKey: "none" },
    sourceFor: noModel,
    triggerPayload: stockTriggerMail({ kind: "pr", repo: pr.repo, policy: { ...DEFAULT_REPO_POLICY, enabled: true }, pack, automatic: [], prNumber: pr.number, headSha: pr.headSha }),
  });
  const verdict = run.outputs["evaluateRules"] as Verdict | undefined;
  if (!verdict) throw new Error(`pr-triage ended ${run.terminalStatus} before evaluating its rules`);
  if (verdict.degraded) return { annotations: [`::error::${escapeData(verdict.reason)}`], summary: [`Triage could not read the pull request: ${verdict.reason}`], failed: true };
  const checks = [...verdict.checks, ...(verdict.labelled ?? [])];
  const hard = hardFailures(verdict.checks);
  const passed = checks.filter((check) => check.result === "pass").length;
  return {
    annotations: checks.filter((check) => check.result === "fail").map((check) => annotation(check, hard)),
    summary: [
      "## Corbits Triage checks",
      "",
      `${passed} of ${checks.length} passed.`,
      "",
      "| Rule | Result | Why |",
      "| --- | --- | --- |",
      ...checks.map(row),
      ...skipped.map((id) => `| ${id} | skipped | answered by a model |`),
    ],
    failed: hard.length > 0,
  };
}
