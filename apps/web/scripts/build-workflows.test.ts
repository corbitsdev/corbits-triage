import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";

import bitbucketTool from "../../../packages/bitbucket-datacenter-tool/package.json";
import githubTool from "../../../packages/github-tool/package.json";
import triageWorkflows from "../../../packages/triage-workflows/package.json";
import { packWorkflows } from "./build-workflows.ts";
import { WORKFLOW_PACKAGES } from "../src/lib/workflow-packages.ts";

const scratch = await mkdtemp(path.join(tmpdir(), "workflow-pack-"));
afterAll(async function cleanup() {
  await rm(scratch, { recursive: true, force: true });
});

async function importsOf(file: string): Promise<string[]> {
  return new Bun.Transpiler({ loader: "js" }).scanImports(await readFile(file, "utf8")).map((entry) => entry.path);
}

test("packs each workflow deterministically, importing the host tools instead of inlining them", async () => {
  const first = await packWorkflows(path.join(scratch, "a"));
  const second = await packWorkflows(path.join(scratch, "b"));
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
});

// Bundling keeps tool imports external, so only loading them against the packed tools shows every imported name exists.
test("every packed workflow entry loads under Node beside the packed tools", async () => {
  const index = await packWorkflows(path.join(scratch, "load"));
  const isWorkflow = (entry: (typeof index)[number]) => entry.name.endsWith("-workflow");
  const tools = new Map<string, string>();
  for (const entry of index.filter((row) => !isWorkflow(row))) {
    const dir = path.join(scratch, "load-tools", entry.name);
    await mkdir(dir, { recursive: true });
    await tar.x({ file: path.join(scratch, "load", entry.filename), cwd: dir, strip: 1 });
    tools.set(entry.name, dir);
  }
  for (const entry of index.filter(isWorkflow)) {
    const dir = path.join(scratch, "load-workflows", entry.name);
    await mkdir(path.join(dir, "node_modules/@corbits"), { recursive: true });
    await tar.x({ file: path.join(scratch, "load", entry.filename), cwd: dir, strip: 1 });
    for (const [name, toolDir] of tools) await symlink(toolDir, path.join(dir, "node_modules", name));
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    // The sidecar installs the native module the manifest names from npm; the workspace's install stands in for it.
    if (manifest.dependencies["@ast-grep/napi"]) {
      await mkdir(path.join(dir, "node_modules/@ast-grep"), { recursive: true });
      await symlink(path.dirname(require.resolve("@ast-grep/napi/package.json", { paths: [path.resolve(import.meta.dir, "../../../packages/triage-workflows")] })), path.join(dir, "node_modules/@ast-grep/napi"));
    }
    for (const rel of [manifest.interchange.workflow, manifest.interchange.directors, manifest.interchange.actions]) {
      const program = `await import(${JSON.stringify(pathToFileURL(path.join(dir, rel)).href)});`;
      const proc = Bun.spawn(["node", "--input-type=module", "-e", program], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect({ entry: `${entry.name} ${rel}`, stderr, code }).toEqual({ entry: `${entry.name} ${rel}`, stderr: "", code: 0 });
    }
  }
}, 120_000);
