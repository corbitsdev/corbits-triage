// Packs each workflow as a source tree into public/packages/, with the host tools it depends on as workspace members,
// which the hub publishes from the built portal.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import * as tar from "tar";
import * as bitbucketTool from "../../../packages/bitbucket-datacenter-tool/build.ts";
import bitbucketPkg from "../../../packages/bitbucket-datacenter-tool/package.json";
import * as githubTool from "../../../packages/github-tool/build.ts";
import githubPkg from "../../../packages/github-tool/package.json";
import triageWorkflowsPkg from "../../../packages/triage-workflows/package.json";
import { contentVersion, type PackedTarball } from "../../../tooling/pack-tarball.ts";
import { CHAIN_PACKAGES, type BuiltPackage, type SourceIndexEntry, type SourceTree } from "@corbits/triage-contracts";

const PACKAGES = resolve(import.meta.dir, "../../../packages");
const PUBLIC = resolve(import.meta.dir, "../public");
const DIRECTORS = "directors.mjs";
const ACTIONS = "actions/index.mjs";
const LOOPS = "loops.mjs";
/**
 * The release a chain workflow deploys from: the hub writes `release.json` into the published tree, so the bundle
 * imports it at run time through the package's own import map, which finds it from any file in the package.
 */
const RELEASE = "#release";
const RELEASE_FILE = "release.json";
const SOURCES = "sources";
const SOURCE_ROOT = { private: true, workspaces: ["packages/*"] };

/** The tool packages published beside each workflow; the workflow imports only these at run time. */
const TOOLS = [
  { name: githubPkg.name, build: githubTool },
  { name: bitbucketPkg.name, build: bitbucketTool },
];
const TOOL_NAMES = TOOLS.map((tool) => tool.name);
const TOOL_IMPORT = new RegExp(`^(${TOOL_NAMES.join("|")})(/.*)?$`);
/** Native modules a bundle cannot hold: each is imported at run time and installed from the registry for the sidecar's platform. */
const NATIVE = { "@ast-grep/napi": triageWorkflowsPkg.dependencies["@ast-grep/napi"] };
const NATIVE_NAMES = Object.keys(NATIVE);
const RUN_TIME_NAMES = [...TOOL_NAMES, ...NATIVE_NAMES];

function loopsOf(workflow: BuiltPackage): string | undefined {
  const loops = join(PACKAGES, workflow.workspace, "src/loops.ts");
  return existsSync(loops) ? loops : undefined;
}

function interchangeEntries(workflow: BuiltPackage) {
  return { workflow: workflow.entry, directors: `./${DIRECTORS}`, actions: `./${ACTIONS}`, ...(loopsOf(workflow) && { loops: `./${LOOPS}` }) };
}

// One build with code splitting, so the workflow, directors and actions share their dependencies in chunks
// and a process that imports all three evaluates the schemas they share once.
async function bundle(workflow: BuiltPackage, outdir: string): Promise<string[]> {
  const src = join(PACKAGES, workflow.workspace, "src");
  const loops = loopsOf(workflow);
  const result = await Bun.build({
    entrypoints: [join(PACKAGES, workflow.workspace, workflow.src), join(src, "directors.ts"), join(src, "actions/index.ts"), ...(loops ? [loops] : [])],
    root: src,
    outdir,
    naming: { entry: "[dir]/[name].mjs", chunk: "chunk-[hash].mjs" },
    splitting: true,
    target: "node",
    format: "esm",
    conditions: ["intx-src"],
    external: NATIVE_NAMES,
    define: { "WORKFLOW_PACKAGE_NAME": JSON.stringify(workflow.packageName) },
    // The packed tools export only their roots, which re-export every subpath the workflows import.
    plugins: [{
      name: "tool-roots",
      setup(build) {
        build.onResolve({ filter: TOOL_IMPORT }, ({ path }) => ({ path: path.replace(TOOL_IMPORT, "$1"), external: true }));
        build.onResolve({ filter: /^\.\/release\.json$/ }, () => ({ path: RELEASE, external: true }));
      },
    }],
    // Strips the per-module path comments: the version hash must not depend on the lockfile layout.
    minify: { whitespace: true },
    sourcemap: "none",
    throw: true,
  });
  return result.outputs.map((output) => relative(outdir, output.path)).sort();
}

// The workflow resolves only its own chunks, the tools and the native modules.
function assertOnlyToolImports(workflow: BuiltPackage, file: string, code: string, outputs: string[]): void {
  // A CommonJS require would load a module the import scan cannot see.
  if (/\bcreateRequire\b|\b__require\b/.test(code)) {
    throw new Error(`${workflow.packageName} bundles a CommonJS require; only ESM imports of ${RUN_TIME_NAMES.join(", ")} are allowed.`);
  }
  for (const { path } of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
    // Bundled dependencies import Node builtins without the node: prefix.
    if (isBuiltin(path.startsWith("node:") ? path : `node:${path}`) || RUN_TIME_NAMES.includes(path)) continue;
    if (path.startsWith(".") && outputs.includes(join(dirname(file), path))) continue;
    if (path === RELEASE) continue;
    throw new Error(`${workflow.packageName} imports ${path} at run time; only ${RUN_TIME_NAMES.join(", ")} are installed beside it.`);
  }
}

async function readTree(dir: string, prefix: string): Promise<SourceTree> {
  const tree: SourceTree = {};
  for await (const file of new Bun.Glob("**").scan(dir)) tree[`${prefix}/${file}`] = await readFile(join(dir, file), "utf8");
  return tree;
}

// Interchange installs only npm dependencies from the registry, so each tool ships as a workspace member holding the
// same files as its tarball.
async function toolMembers(tools: PackedTarball[]): Promise<SourceTree> {
  const stage = await mkdtemp(join(tmpdir(), "tool-members-"));
  try {
    const members: SourceTree = {};
    for (const tool of tools) {
      const dir = join(stage, tool.filename);
      await mkdir(dir);
      await tar.x({ file: tool.path, cwd: dir, strip: 1 });
      Object.assign(members, await readTree(dir, `packages/${tool.name.split("/").pop()}`));
    }
    return members;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// Bundles into `stage`; writes the workflow's source tree beside the tools.
async function packWorkflow(workflow: BuiltPackage, tools: PackedTarball[], members: SourceTree, stage: string, outDir: string): Promise<{ release: boolean; source: SourceIndexEntry }> {
  const outputs = await bundle(workflow, stage);
  const files = Object.fromEntries(outputs.map((output) => [`./${output}`, join(stage, output)]));
  const code = await Promise.all(outputs.map((output) => readFile(join(stage, output), "utf8")));
  const imported = new Set(code.flatMap((source) => new Bun.Transpiler({ loader: "js" }).scanImports(source).map((entry) => entry.path)));
  const native = Object.entries(NATIVE).filter(([name]) => imported.has(name));
  const release = imported.has(RELEASE);
  const fields = {
    type: "module",
    dependencies: Object.fromEntries([...tools.map((tool) => [tool.name, tool.version]), ...native]),
    interchange: interchangeEntries(workflow),
    ...(release && { imports: { [RELEASE]: `./${RELEASE_FILE}` } }),
    files: [...outputs, "package.json"],
  };
  if (!code.some((source) => source.includes(workflow.packageName))) {
    throw new Error(`${workflow.packageName} bundle lacks its package name; the build define was dropped.`);
  }
  for (const [i, output] of outputs.entries()) assertOnlyToolImports(workflow, output, code[i]!, outputs);
  const version = await contentVersion("0.1.0", { name: workflow.packageName, ...fields }, files);
  const manifest = { name: workflow.packageName, version, ...fields };
  const member = `packages/${workflow.name}`;
  const tree: SourceTree = {
    "package.json": `${JSON.stringify(SOURCE_ROOT, null, 2)}\n`,
    ...members,
    [`${member}/package.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    ...Object.fromEntries(outputs.map((output, i) => [`${member}/${output}`, code[i]!])),
    // A workflow that deploys nothing reads an empty release.
    ...(release && { [`${member}/${RELEASE_FILE}`]: "{}\n" }),
  };
  const hash = version.slice(version.lastIndexOf("-") + 1);
  await Bun.write(join(outDir, SOURCES, `${workflow.name}-${hash}.json`), JSON.stringify(tree));
  return { release, source: { workflow: workflow.name, hash } };
}

/** Packs the tool into `into`, from which its files become each workflow's workspace member. */
async function packHostTool(tool: (typeof TOOLS)[number], into: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), "host-tool-"));
  try {
    return await tool.build.packTool(await tool.build.buildEntry(join(stage, "index.js")), into);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packWorkflows(outDir: string): Promise<SourceIndexEntry[]> {
  await rm(outDir, { recursive: true, force: true });
  const stage = await mkdtemp(join(tmpdir(), "workflows-"));
  try {
    const tools: PackedTarball[] = [];
    for (const tool of TOOLS) tools.push(await packHostTool(tool, stage));
    const members = await toolMembers(tools);
    const sources: SourceIndexEntry[] = [];
    for (const workflow of CHAIN_PACKAGES) {
      const built = await packWorkflow(workflow, tools, members, join(stage, workflow.name), outDir);
      const slots = "deploys" in workflow ? workflow.deploys : undefined;
      if (slots?.length && !built.release) throw new Error(`${workflow.packageName} deploys ${slots.map((slot) => slot.workflow).join(", ")} but does not read its release.`);
      sources.push(built.source);
    }
    await Bun.write(join(outDir, SOURCES, "index.json"), `${JSON.stringify(sources, null, 2)}\n`);
    return sources;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const packagesOut = join(PUBLIC, "packages");
  const sources = await packWorkflows(packagesOut);
  console.log(`packed ${sources.length} workflow source trees into ${packagesOut}`);
}
