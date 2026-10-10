import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as tar from "tar";

import pkg from "./package.json";

const PACKAGE_DIR = import.meta.dir;
const ENTRY = "./dist/index.js";
// npm tarballs root every file under this directory.
const STAGE = "package";

const TARBALL_NAME = `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`;

export async function buildEntry(outFile = path.join(PACKAGE_DIR, ENTRY)): Promise<string> {
  await Bun.build({
    entrypoints: [path.join(PACKAGE_DIR, "src/index.ts")],
    outdir: path.dirname(outFile),
    naming: path.basename(outFile),
    target: "node",
    format: "esm",
    conditions: ["intx-src"],
    // Strips the per-module path comments: the bytes must not depend on the lockfile layout.
    minify: { whitespace: true },
    sourcemap: "none",
    throw: true,
  });
  return outFile;
}

async function stagePackage(entryFile: string, outDir: string): Promise<void> {
  const packageDir = path.join(outDir, STAGE);
  await fs.rm(packageDir, { recursive: true, force: true });
  const stagedEntry = path.join(packageDir, ENTRY);
  await fs.mkdir(path.dirname(stagedEntry), { recursive: true });
  await fs.copyFile(entryFile, stagedEntry);
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: "module",
    main: ENTRY,
    exports: { ".": ENTRY },
    files: ["dist", "package.json"],
    interchange: { ...pkg.interchange, tools: ENTRY },
  };
  await Bun.write(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function listSorted(cwd: string, rel: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(cwd, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [rel];
  for (const entry of entries) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await listSorted(cwd, child)));
    else out.push(child);
  }
  return out;
}

// Same source must give the same integrity, so the hub can refuse a republished version with different bytes.
export async function packTarball(entryFile: string, outDir: string): Promise<{ path: string; integrity: string }> {
  await stagePackage(entryFile, outDir);
  const entries = await listSorted(outDir, STAGE);
  for (const rel of entries) {
    const stat = await fs.stat(path.join(outDir, rel));
    await fs.chmod(path.join(outDir, rel), stat.isDirectory() ? 0o755 : 0o644);
  }
  const tarballPath = path.join(outDir, TARBALL_NAME);
  await tar.create(
    { cwd: outDir, gzip: true, file: tarballPath, portable: true, mtime: new Date(0), noDirRecurse: true },
    entries,
  );
  const digest = createHash("sha512").update(await fs.readFile(tarballPath)).digest("base64");
  return { path: tarballPath, integrity: `sha512-${digest}` };
}

if (import.meta.main) {
  const entryFile = await buildEntry();
  if (process.argv[2] === "pack") {
    const { path: tarballPath, integrity } = await packTarball(entryFile, path.dirname(entryFile));
    console.log(`${tarballPath} ${integrity}`);
  }
}
