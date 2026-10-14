import type { ChildProcessEnv } from "../env.js";
import type { SpawnLocalSidecar } from "./local-provisioner.js";

export type CreateSpawnLocalSidecarOpts = {
  readonly interchangeDir: string;
  readonly credentialEncryptionKey: string;
  readonly adapterManifest: string;
  readonly processEnv: ChildProcessEnv;
};

export function createSpawnLocalSidecar({
  interchangeDir,
  credentialEncryptionKey,
  adapterManifest,
  processEnv,
}: CreateSpawnLocalSidecarOpts): SpawnLocalSidecar {
  return function spawnSidecar({ request, dataDir }) {
    const child = Bun.spawn(["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"], {
      cwd: interchangeDir,
      env: {
        ...processEnv,
        HUB_WS_URL: request.hubWebSocketUrl,
        SIDECAR_ID: request.sidecarId,
        SIDECAR_TOKEN: request.token,
        SIDECAR_DATA_DIR: dataDir,
        SIDECAR_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
        SIDECAR_ADAPTER_MANIFEST: adapterManifest,
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      pid: child.pid,
      exited: child.exited,
      kill(signal) {
        child.kill(signal);
      },
    };
  };
}
