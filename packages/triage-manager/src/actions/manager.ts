import type { EffectContext, PerformScope } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { isFromTriageSender, repoSourceOf, triggerRequestOf } from "@corbits/triage-contracts";

/** The effect capability the manager's hub calls declare. */
export const HUB_WRITE = "hub.write";

const Taken = type({ outcome: "'idle' | 'pass'" });
const Done = type({ outcome: "'ended' | 'more'" });

interface Manager {
  tenantId: string;
  /** The top-level run: a deployment's address is its run id at the tenant's domain. */
  runId: string;
  pullRequest: { source: string; repo: string; number: number };
}

/** The pull request the hub's mail names, and the run it was sent to. Only the hub's mail moves the manager. */
function managerOf(payload: unknown): Manager {
  if (!isFromTriageSender(payload)) throw new Error("the mail is not from the hub's Triage sender");
  const { tenantId, repo, prNumber, repoSource } = triggerRequestOf(payload) ?? {};
  if (typeof tenantId !== "string" || typeof repo !== "string" || typeof prNumber !== "number") throw new Error("the mail names no tenant, repository or pull request");
  // The sender check admits only a mail to one bare address.
  const { headers } = payload as { headers: { to: [string] } };
  return { tenantId, runId: headers.to[0].split("@")[0]!, pullRequest: { source: repoSourceOf(repoSource), repo, number: prNumber } };
}

async function hubOf(credentials: PerformScope["credentials"]) {
  const hub = await credentials.resolve(HUB_CREDENTIAL_HANDLE);
  if (hub.kind !== "http") throw new Error(`${HUB_CREDENTIAL_HANDLE} is ${hub.kind}, not http`);
  return hub;
}

/** Asks the hub to stop the run; it is already ending when the hub answers 409. */
async function endRun(ctx: EffectContext, { tenantId, runId }: Manager): Promise<void> {
  async function run({ credentials }: PerformScope) {
    const hub = await hubOf(credentials);
    const response = await hub.fetch(`/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 409) throw new Error(`stopping run ${runId} answered ${response.status}: ${await response.text()}`);
    return { status: response.status };
  }
  await ctx.perform({ effectId: "end", capability: HUB_WRITE, run });
}

/** Posts to the manager route as this run; undefined when the claim names another run, which then ends itself. */
async function asManager(ctx: EffectContext, manager: Manager, route: "take" | "done", body: object): Promise<unknown> {
  async function run({ credentials }: PerformScope) {
    const hub = await hubOf(credentials);
    const response = await hub.fetch(`/api/tenants/${encodeURIComponent(manager.tenantId)}/manager/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 409) return { refused: true };
    if (!response.ok) throw new Error(`${route} answered ${response.status}: ${await response.text()}`);
    return await response.json();
  }
  const answer = await ctx.perform({ effectId: route, capability: HUB_WRITE, run });
  if (asRecord(answer)?.["refused"] !== true) return answer;
  await endRun(ctx, manager);
  return undefined;
}

/** Takes the pull request's pending events, or its open pass again; `taken` is false when there is nothing to do or the run is not the manager. */
export async function take(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ taken: boolean; refused?: true }> {
  const manager = managerOf(input);
  const answered = await asManager(ctx, manager, "take", manager.pullRequest);
  if (answered === undefined) return { taken: false, refused: true };
  const answer = Taken(answered);
  if (answer instanceof type.errors) throw new Error(`take: ${answer.summary}`);
  return { taken: answer.outcome === "pass" };
}

const DoneInput = type({ payload: "unknown", take: { output: { "refused?": "true" } } });

/** Closes the pass; the run ends itself when the hub ends its claim. A run that take refused has ended already. */
export async function done(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ outcome: "ended" | "more" | "refused" }> {
  const parsed = DoneInput(input);
  if (parsed instanceof type.errors) throw new Error(`done: ${parsed.summary}`);
  if (parsed.take.output.refused) return { outcome: "refused" };
  const manager = managerOf(parsed.payload);
  const answered = await asManager(ctx, manager, "done", { ...manager.pullRequest, reviewers: [] });
  if (answered === undefined) return { outcome: "refused" };
  const answer = Done(answered);
  if (answer instanceof type.errors) throw new Error(`done: ${answer.summary}`);
  if (answer.outcome === "ended") await endRun(ctx, manager);
  return answer;
}
