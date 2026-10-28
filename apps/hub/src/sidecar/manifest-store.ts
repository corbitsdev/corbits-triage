import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { errorText } from "@corbits/common";

/** An allocation's sidecar: the identity boot retires and the data directory it removes. No sidecar is started from it. */
export type LocalSidecarManifest = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly dataDir: string;
};

/** What boot reads from a manifest, either this layout's or the one a hub running a single shared sidecar wrote. */
const ListedSidecar = type({ sidecarId: "string > 0" });

export interface LocalSidecarManifestStore {
  write(manifest: LocalSidecarManifest): Promise<void>;
  remove(allocationId: string): Promise<void>;
  /** The identities of every sidecar a manifest names, including one an earlier layout left. */
  listed(): Promise<string[]>;
  /** Removes every manifest and data directory. */
  clear(): Promise<void>;
}

export type CreateLocalSidecarManifestStoreOpts = {
  readonly dataRoot: string;
  readonly log: (entry: Record<string, unknown>) => void;
};

const MANIFESTS = "manifests";
const SHARED_MANIFEST = "sidecar.json";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function createLocalSidecarManifestStore({ dataRoot, log }: CreateLocalSidecarManifestStoreOpts): LocalSidecarManifestStore {
  const manifestsDir = path.join(dataRoot, MANIFESTS);

  function manifestPath(allocationId: string): string {
    return path.join(manifestsDir, `${allocationId}.json`);
  }

  async function write(manifest: LocalSidecarManifest): Promise<void> {
    const target = manifestPath(manifest.allocationId);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.mkdir(manifestsDir, { recursive: true });
    try {
      await fs.writeFile(temp, JSON.stringify(manifest), { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async function remove(allocationId: string): Promise<void> {
    await fs.rm(manifestPath(allocationId), { force: true });
  }

  // A manifest that cannot be read names no sidecar to retire; clear removes it with the rest.
  async function readSidecarId(file: string): Promise<string | undefined> {
    try {
      return ListedSidecar.assert(JSON.parse(await fs.readFile(file, "utf8"))).sidecarId;
    } catch (error) {
      if (isMissing(error)) return undefined;
      log({ level: "warn", msg: "local_sidecar_manifest_unreadable", file, error: errorText(error) });
      return undefined;
    }
  }

  async function listed(): Promise<string[]> {
    const files = (await entries(manifestsDir)).filter((name) => name.endsWith(".json")).map((name) => path.join(manifestsDir, name));
    const sidecarIds: string[] = [];
    for (const file of [...files, path.join(dataRoot, SHARED_MANIFEST)]) {
      const sidecarId = await readSidecarId(file);
      if (sidecarId !== undefined) sidecarIds.push(sidecarId);
    }
    return sidecarIds;
  }

  async function clear(): Promise<void> {
    for (const name of await entries(dataRoot)) await fs.rm(path.join(dataRoot, name), { recursive: true, force: true });
  }

  return { write, remove, listed, clear };
}
