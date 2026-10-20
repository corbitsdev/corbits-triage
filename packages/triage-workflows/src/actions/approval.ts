import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { APPROVE_DO_KIND, DoList, isFromTriageSender, repoSourceOf, triggerRequestOf, type RepoSource } from "@corbits/triage-contracts";
import { parseDoInput, type DoInput } from "@corbits/github-tool/do";
import { doEffectId } from "../logic/actions.js";
import { errorText, isRecord } from "@corbits/common";

export type ApprovalOutput = { approved: false } | ({ approved: true; principalId: string; repoSource?: RepoSource; appLogin?: string } & DoInput) | { approved: true; effectId: string; refused: string };

const Approval = type({
  runId: "string",
  principalId: "string",
  list: DoList,
  index: "number.integer >= 0",
});

/** The held Do an approval mail from the hub's sender names; any other mail goes on to triage, which refuses one it cannot read. */
export async function approval(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<ApprovalOutput> {
  const request = triggerRequestOf(input);
  // Stock admits a mail only when its signature verifies and its From names the signer (INBOUND_MAIL_POLICY.md: only `clean` is admitted by default), so the hub's sender cannot be forged.
  if (request?.["kind"] !== APPROVE_DO_KIND || !isFromTriageSender(input)) return { approved: false };
  let approved: DoInput;
  try {
    approved = parseDoInput(request);
  } catch (e) {
    const effectId = isRecord(request["step"]) && typeof request["step"]["effectId"] === "string" ? request["step"]["effectId"] : "";
    return { approved: true, effectId, refused: errorText(e) };
  }
  const named = Approval(request);
  const { effectId, headSha, kind, target } = approved.step;
  if (named instanceof type.errors) return { approved: true, effectId, refused: `approval names no Do: ${named.summary}` };
  const { repo, number } = approved.request;
  const { list, index, principalId } = named;
  if (doEffectId({ repo, number, headSha, list, index, kind, target }) !== effectId) return { approved: true, effectId, refused: "the approval's effect id does not match its Do" };
  const repoSource = repoSourceOf(request["repoSource"]);
  const appLogin = request["appLogin"];
  return { approved: true, principalId, ...approved, ...(repoSource !== "github" && { repoSource }), ...(typeof appLogin === "string" && { appLogin }) };
}
