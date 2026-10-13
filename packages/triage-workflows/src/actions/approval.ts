import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { APPROVE_DO_KIND, DoBranch, isFromTriageSender, triggerRequestOf } from "@corbits/triage-contracts";
import { parseDoInput, type DoInput } from "@corbits/github-tool";
import { doEffectId } from "../logic/actions.js";
import { errorText, isRecord } from "../logic/extract.js";

export type ApprovalOutput = { approved: false } | ({ approved: true; principalId: string } & DoInput) | { approved: true; effectId: string; refused: string };

/** Names the Do on its verdict, so its effect id can be computed again; `principalId` is who approved it. */
const Approval = type({
  runId: "string",
  principalId: "string",
  actionId: "string",
  branch: DoBranch,
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
  const { actionId, branch, index, principalId } = named;
  if (doEffectId({ repo, number, headSha, actionId, branch, index, kind, target }) !== effectId) return { approved: true, effectId, refused: "the approval's effect id does not match its Do" };
  return { approved: true, principalId, ...approved };
}
