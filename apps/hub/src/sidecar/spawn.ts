import type { ChildProcessEnv } from "../env.js";
import type { LocalSidecarExit, SpawnLocalSidecar } from "./local-provisioner.js";

export type CreateSpawnLocalSidecarOpts = {
  readonly interchangeDir: string;
  readonly credentialEncryptionKey: string;
  readonly processEnv: ChildProcessEnv;
};

async function exitOf(child: Bun.Subprocess): Promise<LocalSidecarExit> {
  const code = await child.exited;
  return { code: child.signalCode === null ? code : null, signal: child.signalCode };
}

export function createSpawnLocalSidecar({
  interchangeDir,
  credentialEncryptionKey,
  processEnv,
}: CreateSpawnLocalSidecarOpts): SpawnLocalSidecar {
  return function spawnSidecar({ sidecarId, token, hubWebSocketUrl, dataDir, adapterManifest }) {
    const child = Bun.spawn(["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"], {
      cwd: interchangeDir,
      env: {
        ...processEnv,
        HUB_WS_URL: hubWebSocketUrl,
        SIDECAR_ID: sidecarId,
        SIDECAR_TOKEN: token,
        SIDECAR_DATA_DIR: dataDir,
        SIDECAR_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
        SIDECAR_ADAPTER_MANIFEST: JSON.stringify(adapterManifest),
        // Each sidecar hosts the one allocation it was started for.
        SIDECAR_MAX_ACTIVE_DEPLOYMENTS: "1",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      pid: child.pid,
      exited: exitOf(child),
      kill(signal) {
        child.kill(signal);
      },
    };
  };
}
