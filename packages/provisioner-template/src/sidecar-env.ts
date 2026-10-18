import { randomBytes } from "node:crypto";
import type { AdapterManifest } from "@intx/types";

export type SidecarEnvOpts = {
  readonly hubWebSocketUrl: string;
  readonly sidecarId: string;
  readonly token: string;
  /** The sidecar's own directory, also its home. */
  readonly dataDir: string;
  readonly adapterManifest: AdapterManifest;
};

/** The environment the stock sidecar starts with, including a credential encryption key of its own. */
export function sidecarEnv({ hubWebSocketUrl, sidecarId, token, dataDir, adapterManifest }: SidecarEnvOpts): Record<string, string> {
  return {
    HUB_WS_URL: hubWebSocketUrl,
    SIDECAR_ID: sidecarId,
    SIDECAR_TOKEN: token,
    SIDECAR_DATA_DIR: dataDir,
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SIDECAR_ADAPTER_MANIFEST: JSON.stringify(adapterManifest),
    HOME: dataDir,
    TMPDIR: "/tmp",
  };
}
