import { type } from "arktype";
import {
  configureGithubApp,
  configureGithubHook,
  ensureGitHubProvider,
  githubAppInstallUrl,
  githubAppSecret,
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
    hook_attributes: { url: "string", active: "true" },
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
  constructor(readonly reason: "replacement_confirmation_required" | "setup_in_progress" | "failed", readonly owned = false) {
    super(reason === "replacement_confirmation_required"
      ? "Replacing the connected GitHub App requires confirmation."
      : reason === "setup_in_progress"
        ? "GitHub setup is already in progress."
      : "The service could not start GitHub setup.");
  }
}

/** The hub stores the new App under the workspace's `github` provider, so that provider must exist first. */
export async function startGithubManifest(
  transport: Transport,
  tenantId: string,
  portalOrigin: string,
  replace: boolean,
  restart: boolean,
): Promise<ManifestStart> {
  await ensureGitHubProvider(transport, tenantId);
  const response = await fetch(`${requestOrigin()}/api/integrations/github-manifest/${encodeURIComponent(tenantId)}/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ portalOrigin, replace, restart }),
  });
  if (!response.ok) {
    let body: { error?: unknown; owned?: unknown } = {};
    try { body = await response.json() as typeof body; } catch { /* generic error below */ }
    const reason = body.error === "replacement_confirmation_required" || body.error === "setup_in_progress" ? body.error : "failed";
    throw new ManifestStartError(reason, body.owned === true);
  }
  return ManifestStart.assert(await response.json());
}

export async function cancelGithubManifest(tenantId: string): Promise<boolean> {
  const response = await fetch(`${requestOrigin()}/api/integrations/github-manifest/${encodeURIComponent(tenantId)}/cancel`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("The service could not cancel GitHub setup.");
  return (await response.json() as { cancelled?: unknown }).cancelled === true;
}

export async function saveExistingGithubApp(input: {
  tenantId: string;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  appSlug?: string;
  replace: boolean;
  credentials: HubCredential[];
}, transport: Transport = createHubTransport()): Promise<void> {
  const exists = input.credentials.some((row) =>
    row.name === GITHUB_CREDENTIAL_NAME || row.name === GITHUB_HOOK_CREDENTIAL_NAME,
  );
  if (exists && !input.replace) throw new ManifestStartError("replacement_confirmation_required");
  await configureGithubApp(
    transport,
    input.tenantId,
    githubAppSecret({ appId: input.appId, privateKey: input.privateKey }),
    [],
    input.appSlug,
  );
  await configureGithubHook(transport, input.tenantId, input.webhookSecret);
}

const SyncResult = type({ repos: "string[]" });
export type SyncResult = typeof SyncResult.infer;

/** Asks the hub to read the App's installations from GitHub and store the repositories it can see. */
export async function syncGithubInstallations(tenantId: string): Promise<SyncResult> {
  const response = await fetch(`${requestOrigin()}/api/integrations/github-installations/${encodeURIComponent(tenantId)}/sync`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = body as { error?: { message?: unknown } };
    throw new Error(typeof failure.error?.message === "string" ? failure.error.message : `HTTP ${response.status}`);
  }
  return SyncResult.assert(body);
}

/** Lists the open pull requests of every connected repository, read live from GitHub. */
export async function loadOpenPulls(tenantId: string): Promise<OpenPulls> {
  const response = await fetch(`${requestOrigin()}/api/integrations/github-open-pulls/${encodeURIComponent(tenantId)}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = body as { error?: { message?: unknown } };
    throw new Error(typeof failure.error?.message === "string" ? failure.error.message : `HTTP ${response.status}`);
  }
  return body as OpenPulls;
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
