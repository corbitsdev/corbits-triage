import { BUILT_IN_CHECK_NAMES, CATALOG_IDS, catalogCheckEnabled, classificationSources, isCatalogId, DEFAULT_REPO_POLICY, hardFailures, isModelCheck, parseCheckPack, stockTriggerMail, type CheckPack } from "@corbits/triage-contracts";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import { PR_TRIAGE, recordingGithub, runLocalWorkflow, type Write } from "@corbits/triage-workflows/run-local";
import type { WorkflowAuthorizeFn } from "@intx/workflow";

interface PullRequest {
  repo: string;
  number: number;
  headSha: string;
}

/** One failed rule, or the pull request left unread when `title` is absent; `error` when it means Fail. */
export interface Failure {
  title?: string;
  error: boolean;
  text: string;
}

/** What one run of the checks says: its failures, summary lines, whether a rule whose failure means Fail failed, whether the pull request was read, and the writes it recorded instead of sending. */
export interface Report {
  failures: Failure[];
  summary: string[];
  failed: boolean;
  unread: boolean;
  writes: Write[];
}

/** A rule left out of the run, with why. */
export type Skipped = { id: string; why: string };

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
 * The pack less every rule a model answers and every enabled rule `unanswered` names, those rules with why each was
 * left out, and every id whose result is dropped. A rule that is not a switch, such as not-a-draft, still runs, and
 * when named is dropped without being listed, since no policy asks for it.
 */
function runnable(pack: CheckPack, unanswered: readonly Skipped[]): { pack: CheckPack; skipped: Skipped[]; left: Set<string> } {
  const { quality, custom } = classificationSources(pack);
  const model = [...quality.map(({ id }) => id), ...custom.map(({ id }) => id)].map((id) => ({ id, why: "answered by a model" }));
  const enabled = unanswered.filter(({ id }) => !isCatalogId(id) || catalogCheckEnabled(pack, id));
  const left = new Set([...model, ...enabled].map(({ id }) => id));
  const off = Object.fromEntries(CATALOG_IDS.filter((id) => left.has(id)).map((id) => [id, { ...pack.checks[id], enabled: false }]));
  return {
    pack: { ...pack, checks: { ...pack.checks, ...off }, custom: pack.custom.filter((row) => !isModelCheck(row) && !left.has(row.id)) },
    skipped: [...model, ...enabled].filter(({ id }) => !BUILT_IN_CHECK_NAMES.has(id)),
    left,
  };
}

/** The Action's workflow command for a failure. */
export function workflowCommand({ title, error, text }: Failure): string {
  return `::${error ? "error" : "warning"}${title === undefined ? "" : ` title=${escapeProperty(title)}`}::${escapeData(text)}`;
}

/** One table cell: on one line, with no `|` ending it early. */
function matchesOf(check: CheckResult): string[] {
  return check.evidence.filter((line) => !check.skipped?.includes(line));
}

function cell(value: string): string {
  return value.replaceAll(/\s+/g, " ").replaceAll("|", "\\|");
}

function row(...cells: string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

/**
 * Runs the policy's rules that need no model, less those `unanswered` names for the pack, against the pull request
 * through the pr-triage definition, with GitHub's reads served by `read`. Each write is recorded in the report and never sent.
 */
export async function runChecks(policy: Record<string, unknown>, pr: PullRequest, read: (url: URL, init?: RequestInit) => Promise<Response>, unanswered: (pack: CheckPack) => Skipped[]): Promise<Report> {
  const parsed = parseCheckPack(policy, pr.repo);
  if (!parsed) throw new Error("the policy is not a check pack");
  const { pack, skipped, left } = runnable(parsed, unanswered(parsed));
  const writes: Write[] = [];
  const run = await runLocalWorkflow({
    ...PR_TRIAGE,
    authorize: allow,
    github: recordingGithub(read, writes),
    inference: { credentialId: "none", origin: "https://model.invalid", apiKey: "none" },
    sourceFor: noModel,
    triggerPayload: stockTriggerMail({ kind: "pr", repo: pr.repo, policy: { ...DEFAULT_REPO_POLICY, enabled: true }, pack, automatic: [], prNumber: pr.number, headSha: pr.headSha }),
  });
  const verdict = run.outputs["evaluateRules"] as Verdict | undefined;
  if (!verdict) throw new Error(`pr-triage ended ${run.terminalStatus} before evaluating its rules`);
  if (verdict.degraded) return { failures: [{ error: true, text: verdict.reason }], summary: [`Triage could not read the pull request: ${cell(verdict.reason)}`], failed: true, unread: true, writes };
  const checks = [...verdict.checks, ...(verdict.labelled ?? [])].filter((check) => !left.has(check.check));
  const hard = hardFailures(verdict.checks);
  const passed = checks.filter((check) => check.result === "pass").length;
  return {
    failures: checks.filter((check) => check.result === "fail").map((check) => ({ title: check.check, error: hard.includes(check), text: [check.reason, ...matchesOf(check)].join("\n") })),
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
    failed: hard.some((check) => !left.has(check.check)),
    unread: false,
    writes,
  };
}
