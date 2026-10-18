import { isThisMachine } from "@corbits/provisioner-docker";
import { createQemuSidecarProvisioner, pingQemuHost, sweepQemuSidecars, type QemuSidecars } from "@corbits/provisioner-qemu";
import type { DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import type { DatabaseConfig, QemuSettings } from "../env.js";
import { activeSidecarIds, hubIdOf, remoteHubProblem } from "./docker.js";

type QemuSidecarProvisioner = QemuSidecars & { readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly qemu: QemuSettings;
  readonly database: DatabaseConfig;
  readonly adapterManifest: AdapterManifest;
};

/** The QEMU provisioner, or why it is not registered. */
export async function connectQemuSidecars({ qemu, database, adapterManifest }: ConnectOpts): Promise<QemuSidecarProvisioner | string> {
  const url = new URL(qemu.url);
  // The bearer token crosses this connection.
  if (url.protocol !== "https:" && !isThisMachine(url.hostname)) return `QEMU_PROVISIONER_URL must be an https:// address, not ${qemu.url}`;
  const hubProblem = remoteHubProblem(`The QEMU host at ${url.host}`, qemu.publicHubWebSocketUrl);
  if (hubProblem !== undefined) return hubProblem;
  const host = { url: qemu.url, token: qemu.token };
  try {
    await pingQemuHost(host);
  } catch (error) {
    return `The QEMU host at ${url.host} refused QEMU_PROVISIONER_TOKEN or did not answer (${String(error)}); check the agent and its token`;
  }
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return `Triage cannot read its database's identity, which keeps its microVMs apart from other servers' (${String(error)})`;
  }
  return {
    host,
    hubId,
    provisioner: createQemuSidecarProvisioner({ host, hubId, adapterManifest, hubWebSocketUrl: qemu.publicHubWebSocketUrl }),
  };
}

/** Removes QEMU sidecars no active allocation or probe holds. */
export async function sweepQemuSidecarsOf(db: DB["db"], qemu: QemuSidecarProvisioner): Promise<number> {
  return sweepQemuSidecars(qemu, await activeSidecarIds(db, qemu.provisioner.id));
}
