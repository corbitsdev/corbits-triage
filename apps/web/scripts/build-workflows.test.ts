import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Packument } from "@intx/tool-packaging";

import bitbucketTool from "../../../packages/bitbucket-datacenter-tool/package.json";
import githubTool from "../../../packages/github-tool/package.json";
import triageWorkflows from "../../../packages/triage-workflows/package.json";
import { packWorkflows } from "./build-workflows.ts";
import { CHAIN_PACKAGES, type SourceIndexEntry, type SourceTree } from "@corbits/triage-contracts";
// Interchange exports only the type; the hub resolves a source deploy's closure with this function.
import { resolveSourceWorkflowClosure, type SourceTreeReads } from "../../../vendor/interchange/packages/hub-sessions/src/workflow-source-closure.ts";

const scratch = await mkdtemp(path.join(tmpdir(), "workflow-pack-"));
afterAll(async function cleanup() {
  await rm(scratch, { recursive: true, force: true });
});

const NAPI = "@ast-grep/napi";
const NAPI_VERSION = triageWorkflows.dependencies[NAPI];
const BUILT = path.join(scratch, "a");
const first = await packWorkflows(BUILT);

test("packs deterministically", async () => {
  expect(await packWorkflows(path.join(scratch, "b"))).toEqual(first);
}, 120_000);

// Reads the tree as the hub reads the pushed commit.
function treeReads(tree: SourceTree): SourceTreeReads {
  function children(dir: string): string[] {
    const prefix = dir === "." ? "" : `${dir}/`;
    return [...new Set(Object.keys(tree).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")[0]!))];
  }
  return {
    async readBlob(file) {
      const contents = tree[file];
      if (contents === undefined) throw new Error(`no blob at ${file}`);
      return new TextEncoder().encode(contents);
    },
    async listDir(dir) {
      const prefix = dir === "." ? "" : `${dir}/`;
      return children(dir).map((name) => ({ name, oid: name, type: `${prefix}${name}` in tree ? "blob" : "tree" }));
    },
    async treeOid(dir) {
      return children(dir).length > 0 ? dir : null;
    },
  };
}

test("each workflow's source tree resolves the way the hub resolves a source deploy, with the host tools as its own members", async () => {
  const sources = JSON.parse(await readFile(path.join(BUILT, "sources/index.json"), "utf8")) as SourceIndexEntry[];
  expect(sources.map((source) => source.workflow)).toEqual(CHAIN_PACKAGES.map((workflow) => workflow.name));
  async function npmOnly(name: string): Promise<Packument> {
    if (name !== NAPI) throw new Error(`${name} resolved from npm`);
    return { name, versions: { [NAPI_VERSION]: { name, version: NAPI_VERSION, dist: { tarball: "https://registry.test/napi.tgz", integrity: "sha512-napi" } } } };
  }
  for (const [i, workflow] of CHAIN_PACKAGES.entries()) {
    const tree = JSON.parse(await readFile(path.join(BUILT, `sources/${workflow.name}-${sources[i]!.hash}.json`), "utf8")) as SourceTree;
    const closure = await resolveSourceWorkflowClosure({
      source: { kind: "asset", assetId: "ast_source", package: { format: "source", commitSha: "c0ffee", packageName: workflow.packageName } },
      reads: treeReads(tree),
      registryName: "npmjs",
      registryConfig: { url: "https://registry.test" },
      fetchPackument: npmOnly,
    });
    const members = closure.entries.filter((entry) => entry.source.kind === "asset").map((entry) => entry.name).sort();
    expect(members).toEqual([workflow.packageName, githubTool.name, bitbucketTool.name].sort());
    const workflowMember = JSON.parse(tree[`packages/${workflow.name}/package.json`]!);
    for (const entry of Object.values(workflowMember.interchange) as string[]) expect(tree[path.posix.join("packages", workflow.name, entry)]).toBeDefined();
    expect(`packages/${workflow.name}/release.json` in tree).toBe("deploys" in workflow);
    expect("loops" in workflowMember.interchange).toBe(workflow.workspace === "triage-manager");
  }
});
