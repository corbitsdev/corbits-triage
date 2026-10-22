import type { GithubFetch } from "@corbits/github-reads";
import { checkName, isModelCheck, QUALITY_CHECK_IDS, stepWords, VERDICT_RULES, VERDICTS, type CheckPack } from "@corbits/triage-contracts";
import * as actions from "@corbits/triage-workflows/actions/index";
import type { RulesOutput } from "@corbits/triage-workflows/actions/rules";
import { credentialBindings } from "@corbits/triage-workflows/agents";
import { localActionCredentials } from "@corbits/triage-workflows/local-credentials";
import { workflow } from "@corbits/triage-workflows/pr-triage-github";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn, type WorkflowRun } from "@intx/workflow";
import { fileNotes, type FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";
import type { VerdictPlan, ViewCheck } from "./view.ts";

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

const QUALITY = new Set<string>(QUALITY_CHECK_IDS);

/** Only the rules run here: the checks a model answers are left out. */
function rulesOnly(pack: CheckPack): CheckPack {
  const checks = Object.fromEntries(Object.entries(pack.checks).map(([id, row]) => [id, QUALITY.has(id) ? { ...row, enabled: false } : row]));
  return { ...pack, checks, custom: pack.custom.filter((check) => !isModelCheck(check)) };
}

/** The policy's steps on each verdict, in words. */
export function plansOf(pack: CheckPack): VerdictPlan[] {
  return VERDICTS.map((verdict) => ({ verdict, when: VERDICT_RULES[verdict], steps: pack.actions[verdict].map(stepWords) }));
}

export type CheckRun = { headSha: string; checks: ViewCheck[]; notes: FileNote[] };

/**
 * pr-triage's definition on one pull request, run by Interchange's local runner over read-only GitHub reads, with the
 * policy's rules only, settling them and writing nothing.
 */
export async function runChecks(pr: PrRef, gh: GithubFetch, policyPack: CheckPack): Promise<CheckRun> {
  const pack = rulesOnly(policyPack);
  const body = (workflow.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the pr-triage body is not inline");
  let run: WorkflowRun | undefined;
  // With the model checks left out no agent step is reached; should one be, the run stops rather than answer without it.
  const noAgents: StepInvoker = async function noAgents(req) {
    await run?.cancel("self", "agent steps are not run in the extension");
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
  const named = checks.map((check) => ({ ...check, name: checkName(pack, check.check) }));
  return { headSha: item.facts.headSha, checks: named, notes: fileNotes(named) };
}
