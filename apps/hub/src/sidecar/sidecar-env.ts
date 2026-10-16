import type { EnsureSidecarRequest } from "@intx/hub-sessions";

/** Every variable a sidecar is started with, from any driver. The hub's own secrets are never among them. */
export type SidecarEnv = {
  readonly HUB_WS_URL: string;
  readonly SIDECAR_ID: string;
  readonly SIDECAR_TOKEN: string;
  readonly SIDECAR_CREDENTIAL_ENCRYPTION_KEY: string;
  readonly SIDECAR_ADAPTER_MANIFEST: string;
};

export type SidecarLaunchSpec = Omit<EnsureSidecarRequest, "signal">;

/** The driver adds `SIDECAR_DATA_DIR`, since where the sidecar's data lives is the backend's. */
export function buildSidecarEnv(launch: SidecarLaunchSpec, credentialEncryptionKey: string): SidecarEnv {
  return {
    HUB_WS_URL: launch.hubWebSocketUrl,
    SIDECAR_ID: launch.sidecarId,
    SIDECAR_TOKEN: launch.token,
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
    SIDECAR_ADAPTER_MANIFEST: JSON.stringify(launch.adapterManifest ?? []),
  };
}
