import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

// npm tarballs root every file under this directory.
const STAGE = "package";

type PackageManifest = { name: string; version: string } & Record<string, unknown>;
export type PackedTarball = { name: string; version: string; filename: string; path: string; integrity: string };

/** The file name `npm pack` gives a package version. */
function tarballFilename(pkg: { name: string; version: string }): string {
  return `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`;
}

function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

async function listSorted(cwd: string, rel: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(cwd, rel), { withFileTypes: true });
  entries.sort(byName);
  const out = [rel];
  for (const entry of entries) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await listSorted(cwd, child)));
    else out.push(child);
  }
  return out;
}

// Same manifest and files always give the same version and changed ones a new version, since a published
// version is never overwritten; `sha-` keeps it valid semver.
export async function contentVersion(
  base: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  for (const file of Object.values(files)) hash.update(await fs.readFile(file));
  return `${base}-sha-${hash.digest("hex").slice(0, 8)}`;
}

// Same input must give the same integrity, so the hub can refuse a republished version with different bytes.
// `files` maps a path inside the package to the source file copied there.
export async function packPackage(
  manifest: PackageManifest,
  files: Record<string, string>,
  outDir: string,
): Promise<PackedTarball> {
  const stageRoot = await fs.mkdtemp(path.join(tmpdir(), "pack-"));
  try {
    const packageDir = path.join(stageRoot, STAGE);
    for (const [rel, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(packageDir, rel)), { recursive: true });
      await fs.copyFile(source, path.join(packageDir, rel));
    }
    await Bun.write(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const entries = await listSorted(stageRoot, STAGE);
    for (const rel of entries) {
      const stat = await fs.stat(path.join(stageRoot, rel));
      await fs.chmod(path.join(stageRoot, rel), stat.isDirectory() ? 0o755 : 0o644);
    }
    const filename = tarballFilename(manifest);
    const tarballPath = path.join(outDir, filename);
    await fs.mkdir(outDir, { recursive: true });
    await tar.create(
      { cwd: stageRoot, gzip: true, file: tarballPath, portable: true, mtime: new Date(0), noDirRecurse: true },
      entries,
    );
    const digest = createHash("sha512").update(await fs.readFile(tarballPath)).digest("base64");
    return { name: manifest.name, version: manifest.version, filename, path: tarballPath, integrity: `sha512-${digest}` };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}
