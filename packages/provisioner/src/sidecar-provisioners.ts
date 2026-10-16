import type { SidecarProvisioner } from "@intx/hub-sessions";
import { createDriverProvisioner, type DriverProvisioner, type SidecarDriver } from "./driver-provisioner.js";

export type SidecarProvisioners = {
  /** For `sidecarProvisioners`: the stock chooser places a deployment on the first that offers what its workflow requires. */
  readonly deployment: readonly SidecarProvisioner[];
  /** For `probeSidecarProvisioners`: probes evaluate only workflow source, so they run on the first driver. */
  readonly probe: readonly SidecarProvisioner[];
  of(driver: SidecarDriver): DriverProvisioner;
  drain(): Promise<void>;
};

/** Drivers in placement order, each sidecar sealed with `credentialEncryptionKey`. */
export function createSidecarProvisioners(drivers: readonly [SidecarDriver, ...SidecarDriver[]], credentialEncryptionKey: string): SidecarProvisioners {
  const seams = new Map(drivers.map((driver) => [driver, createDriverProvisioner(driver, credentialEncryptionKey)] as const));
  const provisioners = [...seams.values()].map((seam) => seam.provisioner);

  function of(driver: SidecarDriver): DriverProvisioner {
    const seam = seams.get(driver);
    if (seam === undefined) throw new Error(`Sidecar driver ${driver.id} is not registered`);
    return seam;
  }

  async function drain(): Promise<void> {
    await Promise.all([...seams.values()].map((seam) => seam.drain()));
  }

  return { deployment: provisioners, probe: provisioners.slice(0, 1), of, drain };
}
