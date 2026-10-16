import type { SidecarProvisioner, SidecarProvisionerChooser } from "@intx/hub-sessions";
import { createDriverProvisioner, type DriverProvisioner, type DriverProvisionerOpts, type SidecarDriver } from "./driver-provisioner.js";

export type SidecarProvisioners = {
  /** For `sidecarProvisioners`: a deployment lands on the first that offers what its workflow requires. */
  readonly deployment: readonly SidecarProvisioner[];
  /** For `sidecarProvisionerChooser`: the first matching driver with room, else the first match (which then refuses as retryable). */
  readonly chooser: SidecarProvisionerChooser;
  /** For `probeSidecarProvisioners`: probes evaluate only workflow source, so they run on the first driver. */
  readonly probe: readonly SidecarProvisioner[];
  of(driver: SidecarDriver): DriverProvisioner;
  drain(): Promise<void>;
};

/** Drivers in placement order. */
export function createSidecarProvisioners(drivers: readonly [SidecarDriver, ...SidecarDriver[]], opts: DriverProvisionerOpts): SidecarProvisioners {
  const seams = drivers.map((driver) => createDriverProvisioner(driver, opts));
  const provisioners = seams.map((seam) => seam.provisioner);

  function of(driver: SidecarDriver): DriverProvisioner {
    const seam = seams[drivers.indexOf(driver)];
    if (seam === undefined) throw new Error(`Sidecar driver ${driver.id} is not registered`);
    return seam;
  }

  async function chooser(candidates: readonly SidecarProvisioner[]): Promise<SidecarProvisioner> {
    for (const candidate of candidates) {
      const seam = seams.find((entry) => entry.provisioner === candidate);
      if (seam !== undefined && (await seam.hasRoom())) return candidate;
    }
    const [first] = candidates;
    if (first === undefined) throw new Error("No matching sidecar provisioners are available");
    return first;
  }

  async function drain(): Promise<void> {
    await Promise.all(seams.map((seam) => seam.drain()));
  }

  return { deployment: provisioners, chooser, probe: provisioners.slice(0, 1), of, drain };
}
