import { catalogCheckEnabled, classificationSources, DEFAULT_REPO_POLICY, isModelCheck, parseCheckPack, stockTriggerMail, type CheckPack } from "@corbits/triage-contracts";
import { hardFailures, type CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import { PR_TRIAGE, recordingGithub, runLocalWorkflow } from "@corbits/triage-workflows/run-local";
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

type Skipped = { id: string; why: string };

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

/**
 * The pack less every rule a model answers, and less ci-green, which the job running it keeps pending; and those
 * rules with why each was left out.
 */
function runnable(pack: CheckPack): { pack: CheckPack; skipped: Skipped[] } {
  const { quality, custom } = classificationSources(pack);
  const ci = catalogCheckEnabled(pack, "ci-green") ? ["ci-green" as const] : [];
  const off = Object.fromEntries([...quality.map(({ id }) => id), ...ci].map((id) => [id, { ...pack.checks[id], enabled: false }]));
  return {
    pack: { ...pack, checks: { ...pack.checks, ...off }, custom: pack.custom.filter((row) => !isModelCheck(row)) },
    skipped: [
      ...[...quality.map(({ id }) => id), ...custom.map(({ id }) => id)].map((id) => ({ id, why: "answered by a model" })),
      ...ci.map((id) => ({ id, why: "cannot be confirmed from inside CI" })),
    ],
  };
}

function annotation(check: CheckResult, hard: readonly CheckResult[]): string {
  return `::${hard.includes(check) ? "error" : "warning"} title=${escapeProperty(check.check)}::${escapeData([check.reason, ...check.evidence].join("\n"))}`;
}

/** One table cell: on one line, with no `|` ending it early. */
function cell(value: string): string {
  return value.replaceAll(/\s+/g, " ").replaceAll("|", "\\|");
}

function row(...cells: string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

/**
 * Runs the policy's rules that need no model against the pull request through the pr-triage definition, with GitHub's
 * reads served by `read` and every write recorded and dropped.
 */
export async function runChecks(policy: Record<string, unknown>, pr: PullRequest, read: (url: URL, init?: RequestInit) => Promise<Response>): Promise<Report> {
  const parsed = parseCheckPack(policy, pr.repo);
  if (!parsed) throw new Error("the policy is not a check pack");
  const { pack, skipped } = runnable(parsed);
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
  if (verdict.degraded) return { annotations: [`::error::${escapeData(verdict.reason)}`], summary: [`Triage could not read the pull request: ${cell(verdict.reason)}`], failed: true };
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
      ...checks.map((check) => row(check.check, check.result, check.reason)),
      ...skipped.map(({ id, why }) => row(id, "skipped", why)),
    ],
    failed: hard.length > 0,
  };
}
