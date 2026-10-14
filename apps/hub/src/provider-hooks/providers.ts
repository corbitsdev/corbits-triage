import { normalizeBitbucket } from "../bitbucket-datacenter/normalize.js";
import { verifySignature } from "../github/signature.js";
import type { ProviderHook } from "./intake.js";

export const PROVIDER_HOOKS: ReadonlyMap<string, ProviderHook> = new Map([
  [
    "bitbucket-datacenter",
    {
      source: "bitbucket-datacenter",
      credential: "bitbucket-datacenter-hook",
      signatureHeader: "x-hub-signature",
      // Bitbucket Data Center signs as GitHub does: `sha256=` and the hex HMAC of the raw body.
      verify: verifySignature,
      eventHeader: "x-event-key",
      deliveryHeader: "x-request-id",
      normalize: normalizeBitbucket,
    },
  ],
]);
