import { setTimeout as sleep } from "node:timers/promises";
import {
  connectRailwaySandboxes,
  createRailwaySidecarProvisioner,
  sidecarTemplate,
  sweepRailwaySidecars,
  type RailwaySidecars,
  type SweepResult,
} from "@corbits/provisioner-railway";
import type { DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import type { DatabaseConfig, RailwaySandboxSettings } from "../env.js";
import { activeSidecarIds, hubIdOf, remoteHubProblem } from "./docker.js";

const SWEEP_AGAIN_MS = 60_000;
const SWEEP_PASSES = 10;

export type RailwaySidecarProvisioner = RailwaySidecars & { readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly railway: RailwaySandboxSettings;
  readonly database: DatabaseConfig;
  readonly adapterManifest: AdapterManifest;
};

/** The Railway sandbox provisioner, or why it is not registered. */
export async function connectRailwaySidecars({ railway, database, adapterManifest }: ConnectOpts): Promise<RailwaySidecarProvisioner | string> {
  const hubProblem = remoteHubProblem("A Railway sandbox", railway.publicHubWebSocketUrl);
  if (hubProblem !== undefined) return hubProblem;
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return `Triage cannot read its database's identity, which keeps its sandboxes apart from other servers' (${String(error)})`;
  }
  const template = sidecarTemplate({ repository: railway.repository, commit: railway.commit });
  const sandboxes = connectRailwaySandboxes({ token: railway.token, environmentId: railway.environmentId }, template);
  return {
    sandboxes,
    hubId,
    provisioner: createRailwaySidecarProvisioner({
      sandboxes,
      hubId,
      environmentId: railway.environmentId,
      adapterManifest,
      hubWebSocketUrl: railway.publicHubWebSocketUrl,
    }),
  };
}

/**
 * Destroys Railway sandboxes no active allocation or probe holds, sweeping again a few times while any sandbox that may
 * be this hub's is still being created or destroyed. `unsettled` counts those still unreadable after the last pass.
 */
export async function sweepRailwaySidecarsOf(db: DB["db"], railway: RailwaySidecarProvisioner): Promise<SweepResult> {
  function active(): Promise<ReadonlySet<string>> {
    return activeSidecarIds(db, railway.provisioner.id);
  }
  let removed = 0;
  for (let pass = 1; ; pass += 1) {
    const swept = await sweepRailwaySidecars(railway, active);
    removed += swept.removed;
    if (swept.unsettled === 0 || pass === SWEEP_PASSES) return { removed, unsettled: swept.unsettled };
    await sleep(SWEEP_AGAIN_MS);
  }
}
