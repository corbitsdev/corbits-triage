import { connectE2b, createE2bSidecarProvisioner, E2B_SIDECAR_TEMPLATE, tendE2bSidecars, type E2bSidecars } from "@corbits/provisioner-e2b";
import type { DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import type { DatabaseConfig, E2bSettings } from "../env.js";
import { activeSidecarIds, hubIdOf, remoteHubProblem } from "./docker.js";

export type E2bSidecarProvisioner = E2bSidecars & { readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly e2b: E2bSettings;
  readonly database: DatabaseConfig;
  readonly adapterManifest: AdapterManifest;
};

/** The E2B provisioner, or why it is not registered. */
export async function connectE2bSidecars({ e2b: settings, database, adapterManifest }: ConnectOpts): Promise<E2bSidecarProvisioner | string> {
  const hubProblem = remoteHubProblem("An E2B sandbox", settings.publicHubWebSocketUrl);
  if (hubProblem !== undefined) return hubProblem;
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return `Triage cannot read its database's identity (${String(error)})`;
  }
  const e2b = connectE2b({ apiKey: settings.apiKey, template: E2B_SIDECAR_TEMPLATE });
  try {
    await e2b.list({});
  } catch (error) {
    return `E2B refused E2B_API_KEY or did not answer (${String(error)}); check the key in the E2B dashboard`;
  }
  return {
    e2b,
    hubId,
    provisioner: createE2bSidecarProvisioner({ e2b, hubId, adapterManifest, hubWebSocketUrl: settings.publicHubWebSocketUrl }),
  };
}

/** Kills E2B sidecars no active allocation or probe holds and keeps the rest alive. */
export async function tendE2bSidecarsOf(db: DB["db"], e2b: E2bSidecarProvisioner): Promise<number> {
  return tendE2bSidecars(e2b, () => activeSidecarIds(db, e2b.provisioner.id));
}
