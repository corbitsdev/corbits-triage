import { join } from "node:path";

/** The data dir the sidecar names in the environment of the workflow process its steps run in. */
export function sidecarDataDir(): string {
  const dir = process.env.SIDECAR_DATA_DIR;
  if (!dir) throw new Error("SIDECAR_DATA_DIR is not set; checkouts exist only on a sidecar");
  return dir;
}

/** The folder every checkout on the sidecar whose data dir is `dataDir` sits under. */
export function checkoutsUnder(dataDir: string): string {
  return join(dataDir, "checkouts");
}
