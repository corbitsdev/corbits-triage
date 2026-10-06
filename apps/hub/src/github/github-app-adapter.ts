import type { AdapterFactory } from "@intx/inference";

import { createGithubAppCredentialFetch } from "./github-app-credential-adapter";

/** Routes GitHub requests carrying App JSON through installation-token minting. */
export function installGithubAppFetch(apiOrigin: string): void {
  globalThis.fetch = Object.assign(
    createGithubAppCredentialFetch({ fetch: globalThis.fetch, apiOrigin }),
    { preconnect: globalThis.fetch.preconnect },
  );
}

function rejectInferenceSelection(): never {
  throw new Error("corbits-github-app-credential is not an inference provider");
}

/**
 * Manifest loading requires an AdapterFactory export. This provider is a
 * transport installation hook, not an inference source, and fails loudly if a
 * deployment ever attempts to select it as one.
 */
export const installGithubAppCredentialAdapter: AdapterFactory = rejectInferenceSelection;
