import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { isFromTriageSender } from "@corbits/triage-contracts";
import type { MailInput } from "../mail.js";
import { Release } from "../release.js";
import { deploy, pullRequestMailOf } from "./hub.js";

const ForwardInput = type({ release: Release, payload: "unknown" });

/** Deploys the pull request's manager from the release and hands the hub's mail on to it. Only the hub's mail moves the listener. */
export async function forward(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ mail: MailInput }> {
  const parsed = ForwardInput(input);
  if (parsed instanceof type.errors) throw new Error(`forward: ${parsed.summary}`);
  if (!isFromTriageSender(parsed.payload)) throw new Error("forward: the mail is not from the hub's Triage sender");
  const { tenantId, request } = pullRequestMailOf(parsed.payload);
  const runId = await deploy(ctx, tenantId, parsed.release);
  return { mail: { tenantId, to: runId, content: JSON.stringify(request), fresh: true } };
}
