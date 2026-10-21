import type { GithubFetch } from "@corbits/github-reads";
import { checkName, classificationSources, type CheckPack } from "@corbits/triage-contracts";
import * as actions from "@corbits/triage-workflows/actions/index";
import type { RulesOutput } from "@corbits/triage-workflows/actions/rules";
import { credentialBindings } from "@corbits/triage-workflows/agents";
import { localActionCredentials } from "@corbits/triage-workflows/local-credentials";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import { workflow } from "@corbits/triage-workflows/pr-triage-github";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn, type WorkflowRun } from "@intx/workflow";
import { fileNotes, type FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";
import type { RuleState, ViewRule } from "./view.ts";

/** The trigger grants no action and every GitHub request but a read is refused, so the run can only read. */
const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

function resolveAction(ref: string): ActionHandler {
  const handler = (actions as Record<string, ActionHandler>)[ref];
  if (!handler) throw new Error(`no action handler ${ref}`);
  return handler;
}

/** The credential's fetch asks for absolute URLs on GitHub's origin; `gh` takes their paths. */
function servedBy(gh: GithubFetch) {
  return async function github(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : input);
    return gh(`${url.pathname}${url.search}`, init);
  };
}

function stateOf(check: CheckResult): RuleState {
  if (check.result === "unconfirmed") return "waiting";
  return check.result;
}

function ruleOf(pack: CheckPack, check: CheckResult): ViewRule {
  return { check: check.check, name: checkName(pack, check.check), kind: "machine", state: stateOf(check), reason: check.reason, evidence: check.evidence };
}

function notRun(pack: CheckPack, id: string): ViewRule {
  return { check: id, name: checkName(pack, id), kind: "model", state: "not-run", reason: "Needs the decision model, which is not run here.", evidence: [] };
}

export type CheckRun = { headSha: string; rules: ViewRule[]; notes: FileNote[] };

/**
 * pr-triage's definition on one pull request, run by Interchange's local runner over the person's read-only token. Its
 * rules step settles every check that needs no model; the model checks are listed as not run here.
 */
export async function runChecks(pr: PrRef, gh: GithubFetch, pack: CheckPack): Promise<CheckRun> {
  const body = (workflow.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the pr-triage body is not inline");
  let run: WorkflowRun | undefined;
  // An agent step comes only after the rules step has settled every other check, so the run stops there, failing
  // closed rather than answering without the model, and is not left to retry it.
  const noAgents: StepInvoker = async function noAgents(req) {
    await run?.cancel("self", "model checks are not run in the extension");
    throw new Error(`${req.agent.id} is not run in the extension`);
  };
  run = runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: noAgents,
    actionResolver: resolveAction,
    actionCredentials: localActionCredentials(credentialBindings, servedBy(gh)),
    triggerPayload: { kind: "pr", repo: pr.repo, prNumber: pr.number, policy: { enabled: true }, pack, automatic: [], events: ["catch-up"] },
  });
  const { outputs } = await run.complete;
  const ruled = outputs["rules"] as RulesOutput | undefined;
  const item = ruled?.items[0];
  if (!item) throw new Error("Triage could not read this pull request.");
  if (item.error !== undefined) throw new Error(item.error);
  const checks = [...item.det.checks, ...(item.det.labelled?.checks ?? [])];
  const { quality, custom } = classificationSources(pack);
  const models = [...quality.map((check) => check.id), ...custom.map((check) => check.id)];
  const named = checks.map((check) => ({ ...check, name: checkName(pack, check.check) }));
  return { headSha: item.facts.headSha, rules: [...checks.map((check) => ruleOf(pack, check)), ...models.map((id) => notRun(pack, id))], notes: fileNotes(named) };
}
