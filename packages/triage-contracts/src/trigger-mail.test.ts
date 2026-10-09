import { describe, expect, test } from "bun:test";
import { assembleMessage, assembleSignedContent, decodeMail } from "@intx/mime";
import { triggerRequestOf } from "./trigger-mail.js";

const SIGNATURE = new TextEncoder().encode("-----BEGIN PGP SIGNATURE-----\nAAAA\n-----END PGP SIGNATURE-----\n");
const INLINE_TEXT_MAX_BYTES = 1024 * 1024;

/** The trigger mail the webhook deliverer signs, decoded and projected the way the stock workflow host stores it. */
function storedTrigger(request: Record<string, unknown>) {
  const raw = assembleMessage(
    {
      from: "github@acme.test", to: ["pr-triage@acme.test"], cc: undefined, date: new Date(), messageId: "<m1@acme.test>",
      subject: undefined, inReplyTo: undefined, references: undefined, mimeVersion: "1.0", interchangeType: "conversation.message",
      interchangeCorrelationId: undefined, interchangeTenantId: "tnt_acme", interchangeAgentId: undefined, interchangeSessionId: undefined,
      interchangeOfferingId: undefined, interchangeSchemaVersion: undefined, traceparent: undefined, tracestate: undefined,
    },
    assembleSignedContent({ kind: "conversation", text: JSON.stringify(request) }),
    SIGNATURE,
  );
  const decoded = decodeMail(raw);
  const parts = decoded.parts.map(function stored(part, i) {
    const ref = `mail-part:///run_x/m1/${i}`;
    return part.content.byteLength <= INLINE_TEXT_MAX_BYTES
      ? { contentType: part.contentType, ref, text: new TextDecoder().decode(part.content) }
      : { contentType: part.contentType, ref };
  });
  return { headers: decoded.headers, rawHeaders: decoded.rawHeaders, parts };
}

describe("triggerRequestOf", () => {
  test("recovers the request from a real trigger mail, stored or stringified", () => {
    const request = { kind: "pr", repo: "acme/widgets", items: [{ prNumber: 1, headSha: "sha1", title: "héllo ✓" }] };
    const mail = storedTrigger(request);
    expect(mail.parts.map((part) => part.contentType)).toEqual(["text/plain"]);
    expect(triggerRequestOf(mail)).toEqual(request);
    expect(triggerRequestOf(JSON.stringify(mail))).toEqual(request);
  });

  test("yields nothing for a ref-only part, a payload without kind, or text that is not JSON", () => {
    expect(triggerRequestOf({ parts: [{ contentType: "text/plain", ref: "mail-part:///run_x/m1/0" }] })).toBeUndefined();
    expect(triggerRequestOf({ repo: "acme/widgets" })).toBeUndefined();
    expect(triggerRequestOf("not json")).toBeUndefined();
  });
});
