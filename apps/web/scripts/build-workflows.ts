// Packs each workflow as a tarball into public/packages/ beside the host tools it depends on, and as a source tree
// with those tools as workspace members, so the portal can publish them to the hub.
import { createHash } from "node:crypto";
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
import { tarballFilename } from "../../../packages/triage-contracts/src/tarball.ts";
import { contentVersion, packPackage, type PackedTarball } from "../../../tooling/pack-tarball.ts";
import { CHAIN_PACKAGES, WORKFLOW_PACKAGES, type BuiltPackage, type PackageIndexEntry, type SourceIndexEntry, type SourceTree } from "../src/lib/workflow-packages.ts";

const PACKAGES = resolve(import.meta.dir, "../../../packages");
const PUBLIC = resolve(import.meta.dir, "../public");
const LOCKFILE = resolve(import.meta.dir, "../../../bun.lock");
const NPM = "https://registry.npmjs.org";
const DIRECTORS = "directors.mjs";
const ACTIONS = "actions/index.mjs";
const LOOPS = "loops.mjs";
/**
 * The release a chain workflow deploys from: the portal writes `release.json` into the published tree, so the bundle
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

// The tarball resolves only its own chunks and the registry asset it is published to, which holds only the tools and native modules.
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

type BuiltWorkflow = { manifest: { name: string; version: string } & Record<string, unknown>; files: Record<string, string>; release: boolean };

// Bundles into `stage`, which must outlive the returned `files`; writes the workflow's source tree beside the tools.
async function packWorkflow(workflow: BuiltPackage, tools: PackedTarball[], members: SourceTree, stage: string, outDir: string): Promise<BuiltWorkflow & { source: SourceIndexEntry }> {
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
  return { manifest, files, release, source: { workflow: workflow.name, hash } };
}

async function packHostTool(tool: (typeof TOOLS)[number], outDir: string): Promise<PackedTarball> {
  const stage = await mkdtemp(join(tmpdir(), "host-tool-"));
  try {
    return await tool.build.packTool(await tool.build.buildEntry(join(stage, "index.js")), outDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

type LockedPackage = [string, string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }, string];
type Platform = { os: string; cpu: string; libc: string };
type PlatformFields = { os?: string[]; cpu?: string[]; libc?: string[] };
/** Where native modules come from: the lockfile pins them, `fetch` reaches the npm registry, `platforms` picks the binaries. */
export type NativeSource = { lockfile: string; fetch: typeof fetch; platforms: Platform[] };

// Sidecar images are Debian, so glibc. The libc filter is load-bearing: the stock resolver and installer match
// only os and cpu, so a musl binary in the registry would be installed beside the glibc one.
export const SIDECAR_PLATFORMS: Platform[] = [{ os: "linux", cpu: "x64", libc: "glibc" }, { os: "linux", cpu: "arm64", libc: "glibc" }];
export const NPM_NATIVE: NativeSource = { lockfile: LOCKFILE, fetch, platforms: SIDECAR_PLATFORMS };

function runsOn(fields: PlatformFields, platform: Platform): boolean {
  return (["os", "cpu", "libc"] as const).every((key) => !fields[key] || fields[key].includes(platform[key]));
}

// A deployment installs only from the registry asset, so each native module ships there with its lockfile closure
// for the given platforms, fetched at the locked version and checked against the locked integrity.
async function fetchNative(outDir: string, { lockfile, fetch, platforms }: NativeSource): Promise<PackedTarball[]> {
  const locked = Bun.JSONC.parse(await readFile(lockfile, "utf8")) as { packages: Record<string, LockedPackage> };
  const declared: Record<string, string> = NATIVE;
  const names = new Set(NATIVE_NAMES);
  const fetched: PackedTarball[] = [];
  for (const name of names) {
    const entry = locked.packages[name];
    if (!entry) throw new Error(`${name} is not in bun.lock.`);
    const [spec, , meta, integrity] = entry;
    const version = spec.slice(spec.lastIndexOf("@") + 1);
    if (name in declared && declared[name] !== version) {
      throw new Error(`Workflows declare ${name}@${declared[name]} but bun.lock resolves ${version}.`);
    }
    const manifestResponse = await fetch(`${NPM}/${name}/${version}`);
    if (!manifestResponse.ok) throw new Error(`Fetching ${name}@${version} metadata failed: HTTP ${manifestResponse.status}.`);
    const manifest = await manifestResponse.json() as PlatformFields;
    if (!platforms.some((platform) => runsOn(manifest, platform))) continue;
    for (const dependency of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) names.add(dependency);
    const url = `${NPM}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetching ${url} failed: HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
      throw new Error(`${name}@${version} from ${url} does not match its bun.lock integrity.`);
    }
    const filename = tarballFilename({ name, version });
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, filename), bytes);
    fetched.push({ name, version, filename, path: join(outDir, filename), integrity });
  }
  return fetched;
}

export async function packWorkflows(outDir: string, native = NPM_NATIVE): Promise<PackageIndexEntry[]> {
  await rm(outDir, { recursive: true, force: true });
  const stage = await mkdtemp(join(tmpdir(), "workflows-"));
  try {
    const tools: PackedTarball[] = [];
    for (const tool of TOOLS) tools.push(await packHostTool(tool, outDir));
    const members = await toolMembers(tools);
    const packed = [...tools, ...await fetchNative(outDir, native)];
    const sources: SourceIndexEntry[] = [];
    for (const workflow of WORKFLOW_PACKAGES) {
      const built = await packWorkflow(workflow, tools, members, join(stage, workflow.name), outDir);
      if (built.release) throw new Error(`${workflow.packageName} reads a release, which only a published source tree holds.`);
      packed.push(await packPackage(built.manifest, built.files, outDir));
      sources.push(built.source);
    }
    for (const workflow of CHAIN_PACKAGES) {
      const built = await packWorkflow(workflow, tools, members, join(stage, workflow.name), outDir);
      const slots = "deploys" in workflow ? workflow.deploys : undefined;
      if (slots?.length && !built.release) throw new Error(`${workflow.packageName} deploys ${slots.map((slot) => slot.workflow).join(", ")} but does not read its release.`);
      sources.push(built.source);
    }
    const index = packed.map(({ name, version, filename, integrity }) => ({ name, version, filename, integrity }));
    await Bun.write(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await Bun.write(join(outDir, SOURCES, "index.json"), `${JSON.stringify(sources, null, 2)}\n`);
    return index;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const packagesOut = join(PUBLIC, "packages");
  const index = await packWorkflows(packagesOut);
  console.log(`packed ${index.length} tarballs into ${packagesOut}`);
}
