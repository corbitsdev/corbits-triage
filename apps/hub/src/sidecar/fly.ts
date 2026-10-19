import { connectFlyMachines, createFlySidecarProvisioner, flySidecarImage, sweepFlySidecars, type FlySidecars } from "@corbits/provisioner-fly";
import type { DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import type { DatabaseConfig, FlySettings } from "../env.js";
import { activeSidecarIds, hubIdOf, inImage, remoteHubProblem } from "./docker.js";

export type FlySidecarProvisioner = FlySidecars & { readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly fly: FlySettings;
  readonly database: DatabaseConfig;
  /** The repository root on the hub. */
  readonly root: string;
  readonly adapterManifest: AdapterManifest;
};

/** The Fly provisioner, or why it is not registered. */
export async function connectFlySidecars({ fly, database, root, adapterManifest }: ConnectOpts): Promise<FlySidecarProvisioner | string> {
  const manifest = inImage(adapterManifest, root);
  if (manifest === undefined) return "Code review cannot run on Fly while GITHUB_API_ORIGIN is set; unset it";
  const hubProblem = remoteHubProblem(`Fly app ${fly.app}`, fly.publicHubWebSocketUrl);
  if (hubProblem !== undefined) return hubProblem;
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return `Triage cannot read its database's identity, which keeps its machines apart from other servers' (${String(error)})`;
  }
  const machines = connectFlyMachines({ token: fly.token, app: fly.app });
  try {
    await machines.list({ corbits_hub: hubId });
  } catch (error) {
    return `Fly refuses FLY_API_TOKEN for the app ${fly.app}, or does not answer (${String(error)})`;
  }
  return {
    machines,
    hubId,
    provisioner: createFlySidecarProvisioner({
      machines,
      hubId,
      image: flySidecarImage(fly.app),
      ...(fly.region !== undefined && { region: fly.region }),
      adapterManifest: manifest,
      hubWebSocketUrl: fly.publicHubWebSocketUrl,
    }),
  };
}

/** Destroys Fly sidecars no active allocation or probe holds. */
export async function sweepFlySidecarsOf(db: DB["db"], fly: FlySidecarProvisioner): Promise<number> {
  return sweepFlySidecars(fly, () => activeSidecarIds(db, fly.provisioner.id));
}
