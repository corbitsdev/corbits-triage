import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CredentialCipher } from "@intx/types";

/** What a hub restart needs to re-spawn an allocation identically. */
export type LocalSidecarManifest = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly hubWebSocketUrl: string;
  readonly dataDir: string;
  readonly token: string;
};

export interface LocalSidecarManifestStore {
  write(manifest: LocalSidecarManifest): Promise<void>;
  /** Reads and decrypts every allocation manifest a previous hub process left behind. */
  readAll(): Promise<LocalSidecarManifest[]>;
  readDataDir(allocationId: string): Promise<string | null>;
  remove(allocationId: string): Promise<void>;
}

export type CreateLocalSidecarManifestStoreOpts = {
  readonly dataRoot: string;
  readonly cipher: CredentialCipher;
};

/** `token` holds the cipher blob, not the plaintext. */
type StoredManifest = LocalSidecarManifest;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Domain-separated from `credentialAad` so a manifest token never decrypts as a credential secret. */
function manifestTokenAad(allocationId: string): string {
  return JSON.stringify(["sidecar-manifest-token", allocationId]);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createLocalSidecarManifestStore({
  dataRoot,
  cipher,
}: CreateLocalSidecarManifestStoreOpts): LocalSidecarManifestStore {
  const dir = path.join(dataRoot, "manifests");

  function manifestPath(allocationId: string): string {
    return path.join(dir, `${allocationId}.json`);
  }

  async function write(manifest: LocalSidecarManifest): Promise<void> {
    const target = manifestPath(manifest.allocationId);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const stored: StoredManifest = {
      ...manifest,
      token: await cipher.encrypt(manifest.token, manifestTokenAad(manifest.allocationId)),
    };
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(temp, JSON.stringify(stored), { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async function readAll(): Promise<LocalSidecarManifest[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const manifests: LocalSidecarManifest[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const manifest = await readEntry(path.join(dir, entry));
      if (manifest !== null) manifests.push(manifest);
    }
    return manifests;
  }

  // An unreadable manifest cannot be respawned, so it is treated as not live.
  async function readEntry(file: string): Promise<LocalSidecarManifest | null> {
    let stored: StoredManifest | undefined;
    try {
      stored = JSON.parse(await fs.readFile(file, "utf8")) as StoredManifest;
      return { ...stored, token: await cipher.decrypt(stored.token, manifestTokenAad(stored.allocationId)) };
    } catch (error) {
      await fs.rm(file, { force: true });
      if (typeof stored?.dataDir === "string" && path.dirname(path.resolve(stored.dataDir)) === path.resolve(dataRoot)) {
        await fs.rm(stored.dataDir, { recursive: true, force: true });
      }
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "local_sidecar_manifest_unreadable_removed",
        file,
        error: errorMessage(error),
      }));
      return null;
    }
  }

  async function readDataDir(allocationId: string): Promise<string | null> {
    try {
      const stored = JSON.parse(await fs.readFile(manifestPath(allocationId), "utf8")) as StoredManifest;
      return stored.dataDir;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function remove(allocationId: string): Promise<void> {
    await fs.rm(manifestPath(allocationId), { force: true });
  }

  return { write, readAll, readDataDir, remove };
}
