import { INFERENCE_CREDENTIAL_NAME, type HubCredential } from "./hub-api.ts";

export function hasDecisionModelCredential(credentials: ReadonlyArray<HubCredential>): boolean {
  return credentials.some((credential) =>
    credential.status === "active"
    && (credential.name === INFERENCE_CREDENTIAL_NAME || credential.name.startsWith(`${INFERENCE_CREDENTIAL_NAME}:`)));
}
