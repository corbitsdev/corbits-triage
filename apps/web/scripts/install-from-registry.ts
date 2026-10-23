// Installs packed workflows the way the hub deploys a tarball workflow: the closure resolves from the
// registry asset alone, then the sidecar's stock installer lays it out.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyFrozenWorkflowClosure, AssetRegistrySource, createClosureResolver, createTarballCache, hostPlatform, parsePin } from "@intx/tool-packaging";
import type { PackageIndexEntry } from "../src/lib/workflow-packages.ts";

const ASSET_ID = "ast_registry";

/** `root/registry/tarballs` holds the index's tarballs; returns each installed workflow's package directory. */
export async function installWorkflows(root: string, index: PackageIndexEntry[]): Promise<string[]> {
  const registry = path.join(root, "registry");
  const source = new AssetRegistrySource({
    name: ASSET_ID,
    assetId: ASSET_ID,
    readBlob: (file) => readFile(path.join(registry, file)),
    listBlobs: (dir) => readdir(path.join(registry, dir)),
  });
  const resolver = createClosureResolver({ registries: new Map([[ASSET_ID, source]]), defaultRegistry: ASSET_ID });
  const cache = createTarballCache({ rootDir: path.join(root, "cache"), maxBytes: 1024 * 1024 * 1024 });
  const installed: string[] = [];
  for (const entry of index.filter((row) => row.name.endsWith("-workflow"))) {
    const { packageDir } = await applyFrozenWorkflowClosure({
      source: { kind: "asset", assetId: ASSET_ID, package: { format: "tarball" } },
      closure: await resolver.resolveClosure([parsePin(`${entry.name}@${entry.version}`)]),
      instanceDir: path.join(root, "instances", entry.name),
      cache,
      registryMaxTarballBytes: 64 * 1024 * 1024,
      registries: new Map(),
      host: hostPlatform(process.platform, process.arch),
      assetRoot: root,
      assetMounts: new Map([[ASSET_ID, "registry"]]),
      loadDefinition: async ({ packageDir }) => ({ id: packageDir }),
    });
    installed.push(packageDir);
  }
  return installed;
}

/** Imports each Interchange entry of an installed workflow, then runs `extra`, in a fresh Node process each. */
export async function loadUnderNode(packageDir: string, extra: string[] = []): Promise<Array<{ program: string; stderr: string; code: number }>> {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const programs = [manifest.interchange.workflow, manifest.interchange.directors, manifest.interchange.actions]
    .map((rel) => `await import(${JSON.stringify(pathToFileURL(path.join(packageDir, rel)).href)});`);
  const results = [];
  for (const program of [...programs, ...extra]) {
    const proc = Bun.spawn(["node", "--input-type=module", "-e", program], { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    results.push({ program, stderr, code });
  }
  return results;
}
