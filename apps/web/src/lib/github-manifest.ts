import { type } from "arktype";
import {
  configureGithubHook,
  ensureGitHubProvider,
  githubAppInstallUrl,
  GITHUB_CREDENTIAL_NAME,
  GITHUB_HOOK_CREDENTIAL_NAME,
  type HubCredential,
  type OpenPulls,
} from "./hub-api.ts";
import { hubOrigin, requestOrigin } from "./hub-origin.ts";
import { createHubTransport, type Transport } from "./hub-transport.ts";

export const GITHUB_MANIFEST_URL = "https://github.com/settings/apps/new";
export const GITHUB_APP_PICKER_UNAVAILABLE =
  "Could not open GitHub’s repository picker. Reload after the service restarts, then try again.";

export function githubWebhookUrl(tenantId: string): string {
  return `${hubOrigin()}/api/hooks/${encodeURIComponent(tenantId)}/github-hook`;
}

const ManifestStart = type({
  manifest: {
    name: "string",
    url: "string",
    /** Absent when the hub is on localhost: the App is created without a webhook. */
    "hook_attributes?": { url: "string", active: "true" },
    redirect_url: "string",
    public: "false",
    default_permissions: "object",
    default_events: "string[]",
    request_oauth_on_install: "false",
    setup_url: "string",
    setup_on_update: "true",
  },
  state: "string > 0",
});
export type ManifestStart = typeof ManifestStart.infer;

export class ManifestStartError extends Error {
  constructor(readonly reason: "replacement_confirmation_required" | "failed") {
    super(reason === "replacement_confirmation_required"
      ? "Replacing the connected GitHub App requires confirmation."
      : "The service could not start GitHub setup.");
  }
}

/** The hub stores the new App under the workspace's `github` provider, so that provider must exist first. */
export async function startGithubManifest(
  transport: Transport,
  tenantId: string,
  portalOrigin: string,
  replace: boolean,
): Promise<ManifestStart> {
  await ensureGitHubProvider(transport, tenantId);
  const response = await fetch(`${requestOrigin()}/api/integrations/github-manifest/${encodeURIComponent(tenantId)}/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ portalOrigin, replace }),
  });
  if (!response.ok) {
    let body: { error?: unknown } = {};
    try { body = await response.json() as typeof body; } catch { /* generic error below */ }
    throw new ManifestStartError(body.error === "replacement_confirmation_required" ? body.error : "failed");
  }
  return ManifestStart.assert(await response.json());
}

export async function saveExistingGithubApp(input: {
  tenantId: string;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  replace: boolean;
  credentials: HubCredential[];
}, transport: Transport = createHubTransport()): Promise<void> {
  const exists = input.credentials.some((row) =>
    row.name === GITHUB_CREDENTIAL_NAME || row.name === GITHUB_HOOK_CREDENTIAL_NAME,
  );
  if (exists && !input.replace) throw new ManifestStartError("replacement_confirmation_required");
  await ensureGitHubProvider(transport, input.tenantId);
  await connectGithubApp(transport, input.tenantId, { appId: input.appId.trim(), privateKey: input.privateKey, replace: input.replace });
  await configureGithubHook(transport, input.tenantId, input.webhookSecret);
}

/** The hub checks the App with GitHub and keeps its key out of the credential triage's workflows use; it refuses another App's ID unless `replace`. */
export async function connectGithubApp(transport: Transport, tenantId: string, app: { appId: string; privateKey: string; replace?: boolean }): Promise<void> {
  await transport.fetch("PUT", `/api/integrations/github-app/${encodeURIComponent(tenantId)}`, app);
}

const SyncResult = type({ repos: "string[]" });
export type SyncResult = typeof SyncResult.infer;

export async function syncGithubInstallations(tenantId: string): Promise<SyncResult> {
  return SyncResult.assert(await createHubTransport().fetch<unknown>("POST", `/api/integrations/github-installations/${encodeURIComponent(tenantId)}/sync`, {}));
}

export async function loadOpenPulls(tenantId: string): Promise<OpenPulls> {
  return createHubTransport().fetch<OpenPulls>("GET", `/api/integrations/github-open-pulls/${encodeURIComponent(tenantId)}`);
}

export function githubAppPickerUrl(slug: string | null): string | null {
  const clean = slug?.trim() ?? "";
  return clean ? githubAppInstallUrl(clean) : null;
}

export function postGithubManifest(start: ManifestStart, documentImpl: Document = document): void {
  const form = documentImpl.createElement("form");
  form.method = "POST";
  form.action = GITHUB_MANIFEST_URL;
  for (const [name, value] of [["manifest", JSON.stringify(start.manifest)], ["state", start.state]]) {
    const input = documentImpl.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  documentImpl.body.append(form);
  form.submit();
  form.remove();
}

export function openGithubInstallation(
  url: string,
  openImpl: (url?: string | URL, target?: string, features?: string) => Window | null = window.open,
): boolean {
  const opened = openImpl(url, "github-app-install", "popup,width=1080,height=760");
  opened?.focus();
  return opened !== null;
}
