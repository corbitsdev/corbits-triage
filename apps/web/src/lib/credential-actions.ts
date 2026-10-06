// SPDX-License-Identifier: GPL-2.0-only
import type { HubCredential } from "./hub-api.ts";

type CredentialAction = "rotate" | "revoke";

type CredentialActions = {
  confirm: (message: string) => boolean | Promise<boolean>;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
};

export function secretDisplayName(storedName: string): string {
  const name = storedName.trim();
  if (name === "github-hook" || name.startsWith("github-hook:")) return "Webhook";
  if (name === "github" || name.startsWith("github:")) return "GitHub App";
  if (name === "corbits-system-one" || name.startsWith("corbits-system-one:")) return "Inference";
  if (!name) return "Secret";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

export function uniqueSecretDisplayNames(credentials: readonly HubCredential[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const credential of credentials) {
    const base = secretDisplayName(credential.name);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const credential of credentials) {
    const base = secretDisplayName(credential.name);
    if ((counts.get(base) ?? 0) < 2) {
      labels.set(credential.id, base);
      continue;
    }
    const hint = credential.name.includes(":") ? credential.name.slice(credential.name.indexOf(":") + 1).trim() : "";
    if (hint) {
      labels.set(credential.id, `${base} · ${hint}`);
      continue;
    }
    const index = (seen.get(base) ?? 0) + 1;
    seen.set(base, index);
    labels.set(credential.id, `${base} ${index}`);
  }
  return labels;
}

export async function runCredentialAction(
  action: CredentialAction,
  credential: HubCredential,
  secret: string,
  actions: CredentialActions,
  displayName = secretDisplayName(credential.name),
): Promise<boolean> {
  const message = action === "rotate"
    ? `Update the ${displayName} secret?`
    : `Remove ${displayName}? Features that use this secret will stop working.`;
  if (!(await actions.confirm(message))) return false;
  if (action === "rotate") await actions.replaceSecret(credential.id, secret);
  else await actions.revoke(credential.id);
  return true;
}
