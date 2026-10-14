// Packs each workflow as a tarball into public/packages/ beside the host tools it depends on,
// so the portal can publish them to the hub.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as bitbucketTool from "../../../packages/bitbucket-datacenter-tool/build.ts";
import bitbucketPkg from "../../../packages/bitbucket-datacenter-tool/package.json";
import * as githubTool from "../../../packages/github-tool/build.ts";
import githubPkg from "../../../packages/github-tool/package.json";
import { contentVersion, packPackage, type PackedTarball } from "../../../tooling/pack-tarball.ts";
import { WORKFLOW_PACKAGES, type PackageIndexEntry, type WorkflowPackage } from "../src/lib/workflow-packages.ts";

const WORKFLOW_SRC = resolve(import.meta.dir, "../../../packages/triage-workflows");
const PUBLIC = resolve(import.meta.dir, "../public");
const DIRECTORS = "directors.mjs";
const ACTIONS = "actions.mjs";

/** The tool packages published beside each workflow; the workflow imports only these at run time. */
const TOOLS = [
  { name: githubPkg.name, build: githubTool },
  { name: bitbucketPkg.name, build: bitbucketTool },
];
const TOOL_NAMES = TOOLS.map((tool) => tool.name);

function interchangeEntries(workflow: WorkflowPackage) {
  return { workflow: workflow.entry, directors: `./${DIRECTORS}`, actions: `./${ACTIONS}` };
}

function workflowEntries(workflow: WorkflowPackage) {
  return [workflow, ...(workflow.variants ?? [])];
}

async function bundle(workflow: WorkflowPackage, outdir: string): Promise<void> {
  const entries = [...workflowEntries(workflow).map((variant) => [variant.src, variant.entry.slice(2)]), ["src/directors.ts", DIRECTORS], ["src/actions/index.ts", ACTIONS]];
  for (const [src, naming] of entries) {
    await Bun.build({
      entrypoints: [join(WORKFLOW_SRC, src)],
      outdir,
      naming,
      target: "node",
      format: "esm",
      conditions: ["intx-src"],
      define: { "TRIAGE_WORKFLOW_PACKAGE_NAME": JSON.stringify(workflow.packageName) },
      // The packed tools export only their roots, so a subpath import would not resolve at run time.
      external: TOOL_NAMES,
      // Strips the per-module path comments: the version hash must not depend on the lockfile layout.
      minify: { whitespace: true },
      sourcemap: "none",
      throw: true,
    });
  }
}

// The tarball resolves only from the registry asset it is published to, which holds nothing but the tools.
function assertOnlyToolImports(workflow: WorkflowPackage, code: string): void {
  // A CommonJS require would load a module the import scan cannot see.
  if (/\bcreateRequire\b|\b__require\b/.test(code)) {
    throw new Error(`${workflow.packageName} bundles a CommonJS require; only ESM imports of ${TOOL_NAMES.join(", ")} are allowed.`);
  }
  for (const { path } of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
    if (path.startsWith("node:") || TOOL_NAMES.includes(path)) continue;
    throw new Error(`${workflow.packageName} imports ${path} at run time; only ${TOOL_NAMES.join(", ")} are published beside it.`);
  }
}

async function packWorkflow(workflow: WorkflowPackage, tools: PackedTarball[], outDir: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), `${workflow.name}-`));
  try {
    await bundle(workflow, stage);
    const variants = workflowEntries(workflow).map((variant) => variant.entry);
    const files = {
      ...Object.fromEntries(variants.map((entry) => [entry, join(stage, entry)])),
      [`./${DIRECTORS}`]: join(stage, DIRECTORS),
      [`./${ACTIONS}`]: join(stage, ACTIONS),
    };
    const manifest = {
      type: "module",
      dependencies: Object.fromEntries(tools.map((tool) => [tool.name, tool.version])),
      interchange: interchangeEntries(workflow),
      files: [...variants.map((entry) => entry.slice(2)), DIRECTORS, ACTIONS, "package.json"],
    };
    if (!(await readFile(files[`./${DIRECTORS}`], "utf8")).includes(workflow.packageName)) {
      throw new Error(`${workflow.packageName} directors bundle lacks its package name; the build define was dropped.`);
    }
    for (const file of Object.values(files)) assertOnlyToolImports(workflow, await readFile(file, "utf8"));
    const version = await contentVersion("0.1.0", { name: workflow.packageName, ...manifest }, files);
    return await packPackage({ name: workflow.packageName, version, ...manifest }, files, outDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function packHostTool(tool: (typeof TOOLS)[number], outDir: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), "host-tool-"));
  try {
    return await tool.build.packTool(await tool.build.buildEntry(join(stage, "index.js")), outDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packWorkflows(outDir: string): Promise<PackageIndexEntry[]> {
  await rm(outDir, { recursive: true, force: true });
  const tools: PackedTarball[] = [];
  for (const tool of TOOLS) tools.push(await packHostTool(tool, outDir));
  const packed = [...tools];
  for (const workflow of WORKFLOW_PACKAGES) packed.push(await packWorkflow(workflow, tools, outDir));
  const index = packed.map(({ name, version, filename, integrity }) => ({ name, version, filename, integrity }));
  await Bun.write(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (import.meta.main) {
  const packagesOut = join(PUBLIC, "packages");
  const index = await packWorkflows(packagesOut);
  console.log(`packed ${index.length} tarballs into ${packagesOut}`);
}
