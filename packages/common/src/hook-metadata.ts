/** Request headers carrying a hook's signature, event name and delivery id, as `metadata.webhook.headers` names them. */
export type HookHeaders = { signature: string; event: string; delivery: string };

export const GITHUB_HOOK_HEADERS: HookHeaders = { signature: "x-hub-signature-256", event: "x-github-event", delivery: "x-github-delivery" };
export const BITBUCKET_DATACENTER_HOOK_HEADERS: HookHeaders = { signature: "x-hub-signature", event: "x-event-key", delivery: "x-request-id" };

export function xHubHookMetadata(workflow: string, headers: HookHeaders) {
  return { webhook: { verify: "x-hub-signature", workflow, headers } };
}
