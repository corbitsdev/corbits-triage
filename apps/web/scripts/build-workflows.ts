// Bundles each workflow package into public/workflows/<name>/ so the portal can push it to the hub,
// and packs each as a tarball into public/packages/ beside the GitHub tool it depends on.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildEntry, packTool } from "../../../packages/github-tool/build.ts";
import tool from "../../../packages/github-tool/package.json";
import { packPackage, type PackedTarball } from "../../../tooling/pack-tarball.ts";
import { WORKFLOW_PACKAGES, type PackageIndexEntry, type WorkflowPackage } from "../src/lib/workflow-packages.ts";

const WORKFLOW_SRC = resolve(import.meta.dir, "../../../packages/triage-workflows");
const PUBLIC = resolve(import.meta.dir, "../public");
const DIRECTORS = "directors.mjs";
const ACTIONS = "actions.mjs";

type BundleOptions = Pick<Bun.BuildConfig, "external" | "minify" | "sourcemap">;

const PACKED: BundleOptions = {
  // The packed tool exports only its root, so a subpath import would not resolve at run time.
  external: [tool.name],
  // Strips the per-module path comments: the version hash must not depend on the lockfile layout.
  minify: { whitespace: true },
  sourcemap: "none",
};

function interchangeEntries(workflow: WorkflowPackage) {
  return { workflow: workflow.entry, directors: `./${DIRECTORS}`, actions: `./${ACTIONS}` };
}

async function bundle(workflow: WorkflowPackage, outdir: string, options: BundleOptions = {}): Promise<void> {
  const entries = [[workflow.src, workflow.entry.slice(2)], ["src/directors.ts", DIRECTORS], ["src/actions/index.ts", ACTIONS]];
  for (const [src, naming] of entries) {
    await Bun.build({
      entrypoints: [join(WORKFLOW_SRC, src)],
      outdir,
      naming,
      target: "node",
      format: "esm",
      conditions: ["intx-src"],
      define: { "process.env.TRIAGE_WORKFLOW_PACKAGE_NAME": JSON.stringify(workflow.packageName) },
      ...options,
      throw: true,
    });
  }
}

async function writeSourcePackage(workflow: WorkflowPackage, outDir: string): Promise<void> {
  const dir = join(outDir, workflow.name);
  await mkdir(dir, { recursive: true });
  await bundle(workflow, dir);
  await Bun.write(join(dir, "package.json"), `${JSON.stringify({
    name: workflow.packageName,
    version: "0.1.0",
    type: "module",
    interchange: interchangeEntries(workflow),
  }, null, 2)}\n`);
}

// The tarball resolves only from the registry asset it is published to, which holds nothing but the tool.
function assertOnlyToolImports(workflow: WorkflowPackage, code: string): void {
  // A CommonJS require would load a module the import scan cannot see.
  if (/\bcreateRequire\b|\b__require\b/.test(code)) {
    throw new Error(`${workflow.packageName} bundles a CommonJS require; only ESM imports of ${tool.name} are allowed.`);
  }
  for (const { path } of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
    if (path.startsWith("node:") || path === tool.name) continue;
    throw new Error(`${workflow.packageName} imports ${path} at run time; only ${tool.name} is published beside it.`);
  }
}

async function packWorkflow(workflow: WorkflowPackage, outDir: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), `${workflow.name}-`));
  try {
    await bundle(workflow, stage, PACKED);
    const files = {
      [workflow.entry]: join(stage, workflow.entry),
      [`./${DIRECTORS}`]: join(stage, DIRECTORS),
      [`./${ACTIONS}`]: join(stage, ACTIONS),
    };
    const manifest = {
      type: "module",
      dependencies: { [tool.name]: tool.version },
      interchange: interchangeEntries(workflow),
      files: [workflow.entry.slice(2), DIRECTORS, ACTIONS, "package.json"],
    };
    const hash = createHash("sha256").update(JSON.stringify({ name: workflow.packageName, ...manifest }));
    for (const file of Object.values(files)) {
      const bytes = await readFile(file);
      assertOnlyToolImports(workflow, bytes.toString("utf8"));
      hash.update(bytes);
    }
    // Content-hashed so the same package always gets the same version; `sha-` keeps it valid semver.
    const version = `0.1.0-sha-${hash.digest("hex").slice(0, 8)}`;
    return await packPackage({ name: workflow.packageName, version, ...manifest }, files, outDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function packGithubTool(outDir: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), "github-tool-"));
  try {
    return await packTool(await buildEntry(join(stage, "index.js")), outDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Packs the GitHub tool and every workflow into `outDir`, with an index.json listing them. */
export async function packWorkflows(outDir: string): Promise<PackageIndexEntry[]> {
  await rm(outDir, { recursive: true, force: true });
  const packed = [await packGithubTool(outDir)];
  for (const workflow of WORKFLOW_PACKAGES) packed.push(await packWorkflow(workflow, outDir));
  const index = packed.map(({ name, version, filename, integrity }) => ({ name, version, filename, integrity }));
  await Bun.write(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (import.meta.main) {
  // The git-push deploy still reads public/workflows; it goes away once the portal deploys the tarballs.
  const sourceOut = join(PUBLIC, "workflows");
  const packagesOut = join(PUBLIC, "packages");
  await rm(sourceOut, { recursive: true, force: true });
  for (const workflow of WORKFLOW_PACKAGES) await writeSourcePackage(workflow, sourceOut);
  const index = await packWorkflows(packagesOut);
  console.log(`built ${WORKFLOW_PACKAGES.length} workflow packages into ${sourceOut} and ${index.length} tarballs into ${packagesOut}`);
}
