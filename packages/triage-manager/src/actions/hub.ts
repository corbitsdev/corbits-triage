import type { EffectContext, PerformScope } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { type, type Type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf, triggerRequestOf } from "@corbits/triage-contracts";
import type { Release } from "../release.js";

/** The effect capability every hub call declares. */
export const HUB_WRITE = "hub.write";

export type PullRequest = { source: string; repo: string; number: number };

/** A mail's request and the run it was sent to; which senders reach a run is its definition's `mailAccept`. */
export function mailOf(payload: unknown): { request: Record<string, unknown>; runId: string } {
  const request = triggerRequestOf(payload);
  if (!request) throw new Error("the mail carries no request");
  const to = asRecord(asRecord(payload)?.["headers"])?.["to"];
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== "string") throw new Error("the mail is not to one run");
  // A deployment's address is its run id at the tenant's domain.
  return { request, runId: to[0].split("@")[0]! };
}

/** The kind of the mail that wakes a manager, which names only its pull request; the manager reads what to do from take. */
const MANAGE_KIND = "manage";

/** What a manager's mail names: the tenant and the pull request, and the run it was sent to. */
export interface ManagerMail {
  tenantId: string;
  runId: string;
  pullRequest: PullRequest;
}

export function managerMailOf(payload: unknown): ManagerMail {
  const { request, runId } = mailOf(payload);
  const { kind, tenantId, repo, prNumber, repoSource } = request;
  if (kind !== MANAGE_KIND || typeof tenantId !== "string" || typeof repo !== "string" || typeof prNumber !== "number") throw new Error("the mail names no tenant, repository or pull request");
  return { tenantId, runId, pullRequest: { source: repoSourceOf(repoSource), repo, number: prNumber } };
}

/** The mail that wakes the manager of `pullRequest`. */
export function manageMail(tenantId: string, { source, repo, number }: PullRequest): string {
  return JSON.stringify({ kind: MANAGE_KIND, tenantId, repo, repoSource: source, prNumber: number });
}

export function tenantPath(tenantId: string, path: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}${path}`;
}

type HubAnswer = { status: number; text: string };

/** One hub call as this run, recorded under `effectId`, so a resumed run does not make it again. */
export async function callHub(ctx: EffectContext, effectId: string, path: string, method: "POST" | "DELETE", body?: object): Promise<HubAnswer> {
  async function run({ credentials }: PerformScope): Promise<HubAnswer> {
    const hub = await credentials.resolve(HUB_CREDENTIAL_HANDLE);
    if (hub.kind !== "http") throw new Error(`${HUB_CREDENTIAL_HANDLE} is ${hub.kind}, not http`);
    const response = await hub.fetch(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }
  return (await ctx.perform({ effectId, capability: HUB_WRITE, run })) as HubAnswer;
}

/** The answer's body, read as `schema`; anything but a 200 or 201 is an error. */
export function answered<T>(answer: HubAnswer, what: string, schema: Type<T>): T {
  if (answer.status !== 200 && answer.status !== 201) throw new Error(`${what} answered ${answer.status}: ${answer.text}`);
  const parsed = schema(JSON.parse(answer.text));
  if (parsed instanceof type.errors) throw new Error(`${what}: ${parsed.summary}`);
  return parsed as T;
}

const Deployed = type({ id: "string > 0" });

/** Deploys the release's workflow through the stock deploy route as this run, under `effectId`; the deployment's run id. */
export async function deploy(ctx: EffectContext, effectId: string, tenantId: string, { workflow, offerings }: Release): Promise<string> {
  const source = { kind: "asset", assetId: workflow.assetId, package: { format: "source", commitSha: workflow.commitSha, packageName: workflow.packageName } };
  const body = { source, entry: workflow.entry, sourceOfferingIds: offerings.ids, defaultSourceOfferingId: offerings.defaultId };
  const answer = await callHub(ctx, effectId, tenantPath(tenantId, "/workflows/deployments"), "POST", body);
  return answered(answer, `deploying ${workflow.packageName}`, Deployed).id;
}

/** Asks the hub to stop the run; it is already ending when the hub answers 409. */
export async function endRun(ctx: EffectContext, tenantId: string, runId: string): Promise<void> {
  const answer = await callHub(ctx, "end", tenantPath(tenantId, `/workflows/runs/${encodeURIComponent(runId)}`), "DELETE");
  if (answer.status >= 300 && answer.status !== 409) throw new Error(`stopping run ${runId} answered ${answer.status}: ${answer.text}`);
}
