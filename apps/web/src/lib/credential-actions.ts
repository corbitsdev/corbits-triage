import { BITBUCKET_DATACENTER_CREDENTIAL_NAME, GITHUB_CREDENTIAL_NAME, GITHUB_HOOK_CREDENTIAL_NAME, INFERENCE_CREDENTIAL_NAME, type HubCredential } from "./hub-api.ts";

type CredentialAction = "rotate" | "revoke";

type CredentialActions = {
  confirm: (message: string) => boolean | Promise<boolean>;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
};

/** Legacy rows carry a `:suffix` after the stored name. */
function storedAs(storedName: string, base: string): boolean {
  const name = storedName.trim();
  return name === base || name.startsWith(`${base}:`);
}

function secretDisplayName(storedName: string): string {
  const name = storedName.trim();
  if (storedAs(name, GITHUB_HOOK_CREDENTIAL_NAME)) return "Webhook";
  if (storedAs(name, GITHUB_CREDENTIAL_NAME)) return "GitHub App";
  if (storedAs(name, INFERENCE_CREDENTIAL_NAME)) return "Inference";
  if (!name) return "Secret";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

export function githubSecrets(credentials: readonly HubCredential[]): HubCredential[] {
  return credentials.filter((credential) => storedAs(credential.name, GITHUB_CREDENTIAL_NAME) || storedAs(credential.name, GITHUB_HOOK_CREDENTIAL_NAME));
}

export function modelSecrets(credentials: readonly HubCredential[]): HubCredential[] {
  return credentials.filter((credential) => storedAs(credential.name, INFERENCE_CREDENTIAL_NAME));
}

const BITBUCKET_DATACENTER_CREDENTIAL_NAMES = new Set([BITBUCKET_DATACENTER_CREDENTIAL_NAME, `${BITBUCKET_DATACENTER_CREDENTIAL_NAME}-hook`]);

/** Bitbucket Data Center's token and hook secret are written and removed only by connecting and disconnecting. */
function bitbucketDatacenterSecrets(credentials: readonly HubCredential[]): HubCredential[] {
  return credentials.filter((credential) => BITBUCKET_DATACENTER_CREDENTIAL_NAMES.has(credential.name.trim()));
}

export function otherSecrets(credentials: readonly HubCredential[]): HubCredential[] {
  const ours = new Set([...githubSecrets(credentials), ...modelSecrets(credentials), ...bitbucketDatacenterSecrets(credentials)]);
  return credentials.filter((credential) => !ours.has(credential));
}

export type NamedSecret = { credential: HubCredential; name: string };

/** Each secret with a name no other secret in `credentials` shares. */
export function namedSecrets(credentials: readonly HubCredential[]): NamedSecret[] {
  const counts = new Map<string, number>();
  for (const credential of credentials) {
    const base = secretDisplayName(credential.name);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const named: NamedSecret[] = [];
  for (const credential of credentials) {
    const base = secretDisplayName(credential.name);
    if ((counts.get(base) ?? 0) < 2) {
      named.push({ credential, name: base });
      continue;
    }
    const hint = credential.name.includes(":") ? credential.name.slice(credential.name.indexOf(":") + 1).trim() : "";
    if (hint) {
      named.push({ credential, name: `${base} · ${hint}` });
      continue;
    }
    const index = (seen.get(base) ?? 0) + 1;
    seen.set(base, index);
    named.push({ credential, name: `${base} ${index}` });
  }
  return named;
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
