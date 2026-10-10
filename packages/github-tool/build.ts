import path from "node:path";

import { packPackage, type PackedTarball } from "../../tooling/pack-tarball.ts";
import pkg from "./package.json";

const PACKAGE_DIR = import.meta.dir;
const ENTRY = "./dist/index.js";

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

export function packTool(entryFile: string, outDir: string): Promise<PackedTarball> {
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
  return packPackage(manifest, { [ENTRY]: entryFile }, outDir);
}

if (import.meta.main) {
  const entryFile = await buildEntry();
  if (process.argv[2] === "pack") {
    const { path: tarballPath, integrity } = await packTool(entryFile, path.dirname(entryFile));
    console.log(`${tarballPath} ${integrity}`);
  }
}
