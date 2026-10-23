import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import bitbucketTool from "../../../packages/bitbucket-datacenter-tool/package.json";
import githubTool from "../../../packages/github-tool/package.json";
import triageWorkflows from "../../../packages/triage-workflows/package.json";
import { packPackage } from "../../../tooling/pack-tarball.ts";
import { packWorkflows, SIDECAR_PLATFORMS, type NativeSource } from "./build-workflows.ts";
import { installWorkflows, loadUnderNode } from "./install-from-registry.ts";
import { WORKFLOW_PACKAGES } from "../src/lib/workflow-packages.ts";

const scratch = await mkdtemp(path.join(tmpdir(), "workflow-pack-"));
afterAll(async function cleanup() {
  await rm(scratch, { recursive: true, force: true });
});

const NAPI = "@ast-grep/napi";
const NAPI_VERSION = triageWorkflows.dependencies[NAPI];
const PLATFORM_GNU = `${NAPI}-linux-x64-gnu`;
const PLATFORM_MUSL = `${NAPI}-linux-x64-musl`;
const FIXTURE = "fixture";
const native = await fixtureNative();

// Stand-ins for the native module and two of its platform binaries, served as the npm registry would.
async function fixtureNative(): Promise<NativeSource> {
  const dir = path.join(scratch, "native");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.js"), `export function parse() { return "${FIXTURE}"; }\n`);
  const fixtures = [
    { name: NAPI, version: NAPI_VERSION, type: "module", main: "index.js", optionalDependencies: { [PLATFORM_GNU]: NAPI_VERSION, [PLATFORM_MUSL]: NAPI_VERSION } },
    { name: PLATFORM_GNU, version: NAPI_VERSION, os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
    { name: PLATFORM_MUSL, version: NAPI_VERSION, os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  ];
  const served = new Map<string, Response>();
  const packages: Record<string, unknown> = {};
  for (const manifest of fixtures) {
    const packed = await packPackage(manifest, { "./index.js": path.join(dir, "index.js") }, path.join(dir, "out"));
    const bytes = await readFile(packed.path);
    const { optionalDependencies } = manifest as { optionalDependencies?: Record<string, string> };
    packages[manifest.name] = [`${manifest.name}@${manifest.version}`, "", { optionalDependencies }, packed.integrity];
    served.set(`https://registry.npmjs.org/${manifest.name}/${manifest.version}`, Response.json(manifest));
    served.set(`https://registry.npmjs.org/${manifest.name}/-/${manifest.name.split("/").pop()}-${manifest.version}.tgz`, new Response(bytes));
  }
  const lockfile = path.join(dir, "bun.lock");
  await writeFile(lockfile, JSON.stringify({ packages }));
  async function serve(input: string | URL | Request): Promise<Response> {
    const response = served.get(String(input));
    if (!response) throw new Error(`The test reached the network: ${String(input)}`);
    return response.clone();
  }
  return { lockfile, fetch: serve as typeof fetch, platforms: SIDECAR_PLATFORMS };
}

async function importsOf(file: string): Promise<string[]> {
  return new Bun.Transpiler({ loader: "js" }).scanImports(await readFile(file, "utf8")).map((entry) => entry.path);
}

test("packs each workflow deterministically, importing the host tools instead of inlining them", async () => {
  const first = await packWorkflows(path.join(scratch, "a"), native);
  const second = await packWorkflows(path.join(scratch, "b"), native);
  expect(second).toEqual(first);

  const tools = [githubTool, bitbucketTool].map(function packed(tool) {
    const entry = first.find((row) => row.name === tool.name);
    if (!entry) throw new Error(`${tool.name} was not packed`);
    return entry;
  });
  for (const workflow of WORKFLOW_PACKAGES) {
    const packed = first.find((entry) => entry.name === workflow.packageName);
    if (!packed) throw new Error(`${workflow.packageName} was not packed`);
    const extracted = path.join(scratch, "extracted", workflow.name);
    await mkdir(extracted, { recursive: true });
    await tar.x({ file: path.join(scratch, "a", packed.filename), cwd: extracted });
    const manifest = JSON.parse(await readFile(path.join(extracted, "package/package.json"), "utf8"));
    const native = workflow.kind === "code-review" ? {} : { "@ast-grep/napi": triageWorkflows.dependencies["@ast-grep/napi"] };
    expect(manifest.dependencies).toEqual({ ...Object.fromEntries(tools.map((tool) => [tool.name, tool.version])), ...native });
    // The sidecar deploys only a package's own workflow entry.
    expect(manifest.interchange.workflow).toBe(workflow.entry);
    const imports = await importsOf(path.join(extracted, "package", workflow.entry));
    const chunkImports = await Promise.all(imports.filter((specifier) => specifier.startsWith("./chunk-")).map((chunk) => importsOf(path.join(extracted, "package", path.posix.dirname(workflow.entry), chunk))));
    for (const tool of tools) expect([...imports, ...chunkImports.flat()]).toContain(tool.name);
    // Directors and actions import the workflow's chunks instead of carrying their own copy of its dependencies.
    for (const entry of [manifest.interchange.directors, manifest.interchange.actions]) {
      const chunks = (await importsOf(path.join(extracted, "package", entry))).map((specifier) => path.posix.join(path.posix.dirname(entry), specifier));
      expect(imports.some((specifier) => specifier.startsWith("./chunk-") && chunks.includes(path.posix.normalize(specifier)))).toBe(true);
    }
  }
}, 120_000);

test("every packed workflow installs from the registry it is published to and loads under Node", async () => {
  const index = await packWorkflows(path.join(scratch, "install/registry/tarballs"), native);
  expect(index.map((entry) => entry.name)).toContain(PLATFORM_GNU);
  expect(index.map((entry) => entry.name)).not.toContain(PLATFORM_MUSL);
  for (const packageDir of await installWorkflows(path.join(scratch, "install"), index)) {
    const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const extra = manifest.dependencies[NAPI] ? [`const { parse } = await import("${NAPI}"); if (parse() !== "${FIXTURE}") throw new Error("not the published module");`] : [];
    for (const result of await loadUnderNode(packageDir, extra)) expect(result).toEqual({ ...result, stderr: "", code: 0 });
  }
}, 120_000);
