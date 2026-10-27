import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { errorText } from "@corbits/common";
import type { CredentialCipher } from "@intx/types";

/** The hub's one local sidecar: the identity it authenticates with and where it keeps its state. */
export type LocalSidecarManifest = {
  readonly sidecarId: string;
  readonly hubWebSocketUrl: string;
  readonly dataDir: string;
  readonly token: string;
};

/** An allocation the sidecar hosts, at the generation and under the identity the hub offered for it. */
const LocalSidecarHold = type({ allocationId: "string > 0", generation: "number.integer >= 0", offeredSidecarId: "string > 0" });
export type LocalSidecarHold = typeof LocalSidecarHold.infer;
const LocalSidecarHolds = LocalSidecarHold.array();

/** A destroyed generation of an allocation, and the identities a late ensure at it may still carry. */
const LocalSidecarFence = type({
  allocationId: "string > 0",
  generation: "number.integer >= 0",
  sidecarIds: "string[]",
  /** The sidecar still hosted the allocation's copy when it was destroyed. */
  "hosted?": "true",
});
export type LocalSidecarFence = typeof LocalSidecarFence.infer;
const LocalSidecarFences = LocalSidecarFence.array();

/** A sidecar a hub that ran one per allocation started, as its manifest in `manifests/` names it. */
const LegacySidecar = type({ allocationId: "string > 0", sidecarId: "string > 0" });
export type LegacySidecar = typeof LegacySidecar.infer;

export interface LocalSidecarManifestStore {
  read(): Promise<LocalSidecarManifest | null>;
  write(manifest: LocalSidecarManifest): Promise<void>;
  remove(): Promise<void>;
  readHolds(): Promise<LocalSidecarHold[]>;
  writeHolds(holds: readonly LocalSidecarHold[]): Promise<void>;
  /** The stored fences, or null when the file could not be read and was moved aside. */
  readFences(): Promise<LocalSidecarFence[] | null>;
  writeFences(fences: readonly LocalSidecarFence[]): Promise<void>;
  /** The sidecars a hub that ran one per allocation left manifests for. */
  legacySidecars(): Promise<LegacySidecar[]>;
  /**
   * Removes the manifests and data directories that hub left, tokens with them, but for the allocations in `kept`;
   * names what went.
   */
  removeLegacyLayout(kept: ReadonlySet<string>): Promise<string[]>;
}

export type CreateLocalSidecarManifestStoreOpts = {
  readonly dataRoot: string;
  readonly cipher: CredentialCipher;
  readonly log: (entry: Record<string, unknown>) => void;
};

const LEGACY_MANIFESTS = "manifests";
const LEGACY_MANIFEST = /^(.+)\.json$/;
const LEGACY_DATA_DIR = /^(.+)-[A-Za-z0-9]{6}$/;

/** Domain-separated from `credentialAad` so a manifest token never decrypts as a credential secret. */
function manifestTokenAad(sidecarId: string): string {
  return JSON.stringify(["sidecar-manifest-token", sidecarId]);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeAtomically(target: string, text: string): Promise<void> {
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export function createLocalSidecarManifestStore({
  dataRoot,
  cipher,
  log,
}: CreateLocalSidecarManifestStoreOpts): LocalSidecarManifestStore {
  const manifestFile = path.join(dataRoot, "sidecar.json");
  const holdsFile = path.join(dataRoot, "holds.json");
  const fencesFile = path.join(dataRoot, "fences.json");

  async function write(manifest: LocalSidecarManifest): Promise<void> {
    const stored = { ...manifest, token: await cipher.encrypt(manifest.token, manifestTokenAad(manifest.sidecarId)) };
    await writeAtomically(manifestFile, JSON.stringify(stored));
  }

  // An unreadable manifest names no sidecar that can be respawned.
  async function read(): Promise<LocalSidecarManifest | null> {
    const text = await readOptional(manifestFile);
    if (text === null) return null;
    try {
      const stored = JSON.parse(text) as LocalSidecarManifest;
      return { ...stored, token: await cipher.decrypt(stored.token, manifestTokenAad(stored.sidecarId)) };
    } catch (error) {
      await fs.rm(manifestFile, { force: true });
      log({ level: "warn", msg: "local_sidecar_manifest_unreadable_removed", file: manifestFile, error: errorText(error) });
      return null;
    }
  }

  async function remove(): Promise<void> {
    await fs.rm(manifestFile, { force: true });
  }

  // An unreadable holds file names nothing restore can bring back; the hub places that work again.
  async function readHolds(): Promise<LocalSidecarHold[]> {
    const text = await readOptional(holdsFile);
    if (text === null) return [];
    try {
      return LocalSidecarHolds.assert(JSON.parse(text));
    } catch (error) {
      await fs.rm(holdsFile, { force: true });
      log({ level: "warn", msg: "local_sidecar_holds_unreadable_removed", file: holdsFile, error: errorText(error) });
      return [];
    }
  }

  async function writeHolds(holds: readonly LocalSidecarHold[]): Promise<void> {
    await writeAtomically(holdsFile, JSON.stringify(holds));
  }

  // An unreadable fences file is kept aside for the operator; null tells restore its fences are lost.
  async function readFences(): Promise<LocalSidecarFence[] | null> {
    const text = await readOptional(fencesFile);
    if (text === null) return [];
    try {
      return LocalSidecarFences.assert(JSON.parse(text));
    } catch (error) {
      const aside = `${fencesFile}.corrupt-${String(Date.now())}`;
      await fs.rename(fencesFile, aside);
      log({ level: "warn", msg: "local_sidecar_fences_unreadable_moved", file: fencesFile, aside, error: errorText(error) });
      return null;
    }
  }

  async function writeFences(fences: readonly LocalSidecarFence[]): Promise<void> {
    await writeAtomically(fencesFile, JSON.stringify(fences));
  }

  async function legacyEntries(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  // A manifest that cannot be read names no sidecar to retire; it goes with the layout.
  async function legacySidecars(): Promise<LegacySidecar[]> {
    const manifestsDir = path.join(dataRoot, LEGACY_MANIFESTS);
    const sidecars: LegacySidecar[] = [];
    for (const name of await legacyEntries(manifestsDir)) {
      if (!LEGACY_MANIFEST.test(name)) continue;
      try {
        sidecars.push(LegacySidecar.assert(JSON.parse(await fs.readFile(path.join(manifestsDir, name), "utf8"))));
      } catch (error) {
        log({ level: "warn", msg: "local_sidecar_legacy_manifest_unreadable", file: name, error: errorText(error) });
      }
    }
    return sidecars;
  }

  async function removeLegacyLayout(kept: ReadonlySet<string>): Promise<string[]> {
    const manifestsDir = path.join(dataRoot, LEGACY_MANIFESTS);
    if (!(await exists(manifestsDir))) return [];
    const removed: string[] = [];
    for (const name of await legacyEntries(manifestsDir)) {
      const allocationId = LEGACY_MANIFEST.exec(name)?.[1];
      if (allocationId !== undefined && kept.has(allocationId)) continue;
      removed.push(path.join(LEGACY_MANIFESTS, name));
    }
    for (const name of await legacyEntries(dataRoot)) {
      const allocationId = LEGACY_DATA_DIR.exec(name)?.[1];
      if (allocationId !== undefined && !kept.has(allocationId) && (await fs.stat(path.join(dataRoot, name))).isDirectory()) removed.push(name);
    }
    for (const name of removed) await fs.rm(path.join(dataRoot, name), { recursive: true, force: true });
    if ((await legacyEntries(manifestsDir)).length === 0) {
      await fs.rm(manifestsDir, { recursive: true, force: true });
      removed.push(LEGACY_MANIFESTS);
    }
    return removed;
  }

  return { read, write, remove, readHolds, writeHolds, readFences, writeFences, legacySidecars, removeLegacyLayout };
}
