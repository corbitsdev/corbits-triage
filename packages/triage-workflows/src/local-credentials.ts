import { actionConsumer, toolConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import type { CredentialDelivery } from "@intx/types/credential-delivery";

const GITHUB_ORIGIN = "https://api.github.com";

/** The GitHub bindings, of tool packages and of action handlers. */
export type Bindings = readonly ({ handle: string; package: string } | { handle: string; action: string })[];

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function consumerOf(binding: Bindings[number]): string {
  return "package" in binding ? toolConsumer(binding.package) : actionConsumer(binding.action);
}

/** The credential-use grants the hub stamps on a run from a definition's bindings. */
export function grantsFor(bindings: Bindings): GrantRule[] {
  return bindings.map((binding, index) => ({
    id: `grant-${index}`,
    resource: "credential:github",
    action: "use",
    effect: "allow",
    origin: "system",
    conditions: { tool: consumerOf(binding) },
    expiresAt: null,
    roleId: null,
    principalId: null,
  }));
}

/** What the hub delivers a run from a definition's GitHub bindings, with any other `materials` its steps use. */
export function delivered(bindings: Bindings, materials: CredentialDelivery["materials"] = []): { current: CredentialDelivery } {
  return {
    current: {
      bindings: bindings.map((binding) => ({ handle: binding.handle, credentialId: "github", consumer: consumerOf(binding) })),
      materials: [{ credentialId: "github", providerKey: "http", origin: GITHUB_ORIGIN, secret: "local" }, ...materials],
    },
  };
}

/** The credentials a deployed run's action handlers resolve, as the sidecar builds them, with GitHub served by `github`. */
export function localActionCredentials(bindings: Bindings, github: Fetch, cell = delivered(bindings)) {
  const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: github })]);
  return createActionCredentialsFactory({ materialCell: cell, resolveStepGrants: () => grantsFor(bindings), providers });
}
