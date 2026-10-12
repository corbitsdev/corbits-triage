import { expect, test } from "bun:test";

import { isFromTriageSender } from "../packages/triage-contracts/src/trigger-mail";
import { workflow as prTriage } from "../packages/triage-workflows/src/pr-triage";
import { createDetachedSignatureWithSigner, createEd25519Crypto, generateKeyPair, type Ed25519Crypto } from "../vendor/interchange/packages/crypto/src/index";
// Stock's inbound mail gate is not exported; the sidecar runs exactly this on every mail.inbound frame.
import { decideInboundAdmission, resolveInboundMailPolicy, verifyInboundSignature } from "../vendor/interchange/packages/hub-agent/src/ws/inbound-signature";
import { assembleMessage, assembleSignedContent, decodeMail } from "../vendor/interchange/packages/mime/src/index";

const DOMAIN = "acme.test";
const DEPLOYMENT = `run_triage@${DOMAIN}`;
const HUB = `github@${DOMAIN}`;
const MEMBER_RUN = `run_member@${DOMAIN}`;

async function signedMail(from: string, key: Ed25519Crypto): Promise<Uint8Array> {
  const signed = assembleSignedContent({ kind: "conversation", text: JSON.stringify({ kind: "pr", repo: "acme/widgets", items: [] }) });
  const headers = {
    from, to: [DEPLOYMENT], cc: undefined, date: new Date(), messageId: `<m1@${DOMAIN}>`, subject: undefined, inReplyTo: undefined, references: undefined,
    mimeVersion: "1.0" as const, interchangeType: "conversation.message" as const, interchangeCorrelationId: undefined, interchangeTenantId: "tnt_acme",
    interchangeAgentId: undefined, interchangeSessionId: undefined, interchangeOfferingId: undefined, interchangeSchemaVersion: undefined, traceparent: undefined, tracestate: undefined,
  };
  return assembleMessage(headers, signed, await createDetachedSignatureWithSigner(signed, (input) => key.sign(input)));
}

/** Whether stock admits `raw` to pr-triage when the hub authenticated `stamp` as its sender, and if so whether the facts director would take it for the hub's. */
async function delivered(raw: Uint8Array, stamp: string, keys: Map<string, Ed25519Crypto>) {
  const verdict = await verifyInboundSignature({ raw, authenticatedSender: stamp, messageId: undefined, agentAddress: DEPLOYMENT }, (address) => keys.get(address));
  if (decideInboundAdmission(verdict, resolveInboundMailPolicy(prTriage.inboundMailPolicy)).rejectedBy !== null) return "rejected";
  return isFromTriageSender(JSON.stringify({ headers: decodeMail(raw).headers })) ? "hub" : "other";
}

test("stock's inbound gate lets only the hub's own mail read as its triage sender's", async () => {
  const hub = createEd25519Crypto(await generateKeyPair());
  const member = createEd25519Crypto(await generateKeyPair());
  const keys = new Map([[HUB, hub], [MEMBER_RUN, member]]);

  expect(await delivered(await signedMail(HUB, hub), HUB, keys)).toBe("hub");
  expect(await delivered(await signedMail(HUB, member), MEMBER_RUN, keys)).toBe("rejected");
  expect(await delivered(await signedMail(`"<${HUB}>" <${MEMBER_RUN}>`, member), MEMBER_RUN, keys)).toBe("other");
});
