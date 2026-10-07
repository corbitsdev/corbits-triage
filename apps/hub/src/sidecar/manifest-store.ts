import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  /** 32 bytes as 64 hex characters; encrypts sidecar tokens at rest in manifests. */
  readonly encryptionKey: string;
};

type EncryptedToken = {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

type StoredManifest = Omit<LocalSidecarManifest, "token"> & {
  readonly token: EncryptedToken;
};

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Local sidecar manifest encryption key must be 32 bytes encoded as 64 hexadecimal characters");
  }
  return Buffer.from(hex, "hex");
}

function encryptToken(key: Buffer, token: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptToken(key: Buffer, token: EncryptedToken): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(token.iv, "base64"));
  decipher.setAuthTag(Buffer.from(token.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(token.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createLocalSidecarManifestStore({
  dataRoot,
  encryptionKey,
}: CreateLocalSidecarManifestStoreOpts): LocalSidecarManifestStore {
  const key = parseKey(encryptionKey);
  const dir = path.join(dataRoot, "manifests");

  function manifestPath(allocationId: string): string {
    return path.join(dir, `${allocationId}.json`);
  }

  async function write(manifest: LocalSidecarManifest): Promise<void> {
    const target = manifestPath(manifest.allocationId);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const stored: StoredManifest = { ...manifest, token: encryptToken(key, manifest.token) };
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
      const stored = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as StoredManifest;
      manifests.push({ ...stored, token: decryptToken(key, stored.token) });
    }
    return manifests;
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
