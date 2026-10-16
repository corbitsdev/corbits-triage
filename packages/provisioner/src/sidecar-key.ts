import { hkdfSync } from "node:crypto";

/**
 * A sidecar credential key of the driver's own, derived from the root key. Code in one driver's sidecars
 * can read its key, so a key leaked from one backend never unseals another backend's stores.
 */
export function deriveSidecarKey(rootKeyHex: string, driverId: string): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(rootKeyHex, "hex"), new Uint8Array(0), `intx-sidecar-key:${driverId}`, 32)).toString("hex");
}
