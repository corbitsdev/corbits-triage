import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import tool from "../../../packages/github-tool/package.json";
import { packWorkflows } from "./build-workflows.ts";
import { WORKFLOW_PACKAGES } from "../src/lib/workflow-packages.ts";

const scratch = await mkdtemp(path.join(tmpdir(), "workflow-pack-"));
afterAll(async function cleanup() {
  await rm(scratch, { recursive: true, force: true });
});

test("packs each workflow deterministically, importing the GitHub tool instead of inlining it", async () => {
  const first = await packWorkflows(path.join(scratch, "a"));
  const second = await packWorkflows(path.join(scratch, "b"));
  expect(second).toEqual(first);

  for (const workflow of WORKFLOW_PACKAGES) {
    const packed = first.find((entry) => entry.name === workflow.packageName);
    if (!packed) throw new Error(`${workflow.packageName} was not packed`);
    const extracted = path.join(scratch, "extracted", workflow.name);
    await mkdir(extracted, { recursive: true });
    await tar.x({ file: path.join(scratch, "a", packed.filename), cwd: extracted });
    const manifest = JSON.parse(await readFile(path.join(extracted, "package/package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ [tool.name]: tool.version });
    const bundle = await readFile(path.join(extracted, "package", workflow.entry), "utf8");
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(bundle).map((entry) => entry.path);
    expect(imports).toContain(tool.name);
  }
});
