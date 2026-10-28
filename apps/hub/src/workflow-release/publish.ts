// Publishes the hub build's workflows as source assets of the workspace's publisher, one asset per workflow and release.
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import git from "isomorphic-git";
import { schema, type DB } from "@intx/db";
import { AssetServiceError, DEFAULT_ASSET_REF, type AssetService, type RepoStore } from "@intx/hub-sessions";
import { deployedByChain, publishable, withRelease, workflowTimings, type ModelInfo, type PublishedSource, type SourceIndexEntry, type SourceTree } from "@corbits/triage-contracts";
import { allowCreator } from "../github/admin-github-grant.js";
import { timings } from "../timings.js";

/** The workflow sources the portal build writes under `packages/sources/`, in the order they publish. */
export type Bundle = {
  index: () => Promise<SourceIndexEntry[]>;
  tree: (entry: SourceIndexEntry) => Promise<SourceTree>;
};

/** The workspace and its system principal, the creator of every asset it publishes and so the authority of every deployment. */
export type Publisher = { tenantId: string; principalId: string };

export type PublishDeps = {
  db: DB["db"];
  assets: Pick<AssetService, "createAsset" | "populateAsset" | "readAssetBlob">;
  repoStore: Pick<RepoStore, "resolveRef" | "getRepoDir">;
  now: () => Date;
};

const HUB = { kind: "hub" } as const;

/** Whether the build at `dir` holds the sources index the hub publishes from. */
export function bundled(dir: string): boolean {
  return fs.existsSync(join(dir, "sources", "index.json"));
}

/** A build never changes under a running hub, so each file is read once. */
export function bundleAt(dir: string): Bundle {
  const read = new Map<string, unknown>();
  async function json(file: string): Promise<unknown> {
    if (read.has(file)) return read.get(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, "sources", file), "utf8"));
    } catch (cause) {
      throw new Error(`The hub build is missing sources/${file}.`, { cause });
    }
    read.set(file, parsed);
    return parsed;
  }
  return {
    async index() {
      return await json("index.json") as SourceIndexEntry[];
    },
    async tree(entry) {
      return await json(`${entry.workflow}-${entry.hash}.json`) as SourceTree;
    },
  };
}

/** Asset names are lowercase kebab, so the principal id's `prn_` becomes `prn-`. */
function assetName(workflow: string, { principalId }: Publisher, hash: string): string {
  return `${workflow}-${principalId.replaceAll("_", "-")}-${hash}`;
}

async function ensureAsset(deps: PublishDeps, { tenantId, principalId }: Publisher, name: string): Promise<{ id: string; creatorPrincipalId: string | null }> {
  const { asset } = schema;
  const found = await deps.db.query.asset.findFirst({
    where: and(eq(asset.tenantId, tenantId), eq(asset.kind, "workflow"), eq(asset.name, name)),
    columns: { id: true, creatorPrincipalId: true },
  });
  return found ?? deps.assets.createAsset({ tenantId, kind: "workflow", name, creatorPrincipalId: principalId });
}

/** The asset's release commit; a new asset holds only the hub's first commit, which has no package. */
async function releaseCommit(deps: PublishDeps, assetId: string): Promise<string | undefined> {
  try {
    await deps.assets.readAssetBlob({ assetId, path: "package.json" });
  } catch (error) {
    if (error instanceof AssetServiceError && error.reason === "not_found") return undefined;
    throw error;
  }
  const sha = await deps.repoStore.resolveRef(HUB, { kind: "workflow", id: assetId }, DEFAULT_ASSET_REF);
  if (sha === null) throw new Error(`Asset ${assetId} has no ${DEFAULT_ASSET_REF}.`);
  return sha;
}

async function storedBlobs(dir: string, treeOid: string, prefix: string, into: Map<string, string>): Promise<void> {
  const { tree } = await git.readTree({ fs, dir, oid: treeOid });
  for (const entry of tree) {
    const path = `${prefix}${entry.path}`;
    if (entry.type === "tree") await storedBlobs(dir, entry.oid, `${path}/`, into);
    else into.set(path, entry.oid);
  }
}

/** Whether the commit holds exactly the release's files, besides the `.gitignore` every asset starts with. */
async function holdsRelease(deps: PublishDeps, assetId: string, commitSha: string, tree: SourceTree): Promise<boolean> {
  const dir = deps.repoStore.getRepoDir({ kind: "workflow", id: assetId });
  const { commit } = await git.readCommit({ fs, dir, oid: commitSha });
  const stored = new Map<string, string>();
  await storedBlobs(dir, commit.tree, "", stored);
  if (!(".gitignore" in tree)) stored.delete(".gitignore");
  if (stored.size !== Object.keys(tree).length) return false;
  for (const [path, contents] of Object.entries(tree)) {
    if (stored.get(path) !== (await git.hashBlob({ object: contents })).oid) return false;
  }
  return true;
}

async function publishSource(deps: PublishDeps, publisher: Publisher, workflow: string, name: string, tree: SourceTree): Promise<PublishedSource> {
  const asset = await ensureAsset(deps, publisher, name);
  // A deployment's permissions come from its asset's creator.
  if (asset.creatorPrincipalId !== publisher.principalId) throw new Error(`${name} was created by someone else; publishing to it would deploy under their permissions.`);
  // A deployed workflow deploys the next one under its creator's read on that one's asset, which stock does not give a creator.
  if (deployedByChain(workflow)) {
    await deps.db.transaction(function grantRead(tx) {
      return allowCreator(tx, publisher.tenantId, publisher.principalId, `asset:${asset.id}`, "read", deps.now());
    });
  }
  const published = await releaseCommit(deps, asset.id);
  if (published !== undefined) {
    if (!(await holdsRelease(deps, asset.id, published, tree))) throw new Error(`${name} holds ${published}, which is not this release, so the hub does not deploy it.`);
    return { workflow, assetId: asset.id, commitSha: published };
  }
  const { commitSha } = await deps.assets.populateAsset({ assetId: asset.id, ref: DEFAULT_ASSET_REF, tree: { files: tree, message: name }, principal: HUB });
  return { workflow, assetId: asset.id, commitSha };
}

/**
 * Publishes the build's workflows in its order, so each chain workflow follows the one it deploys; a release already
 * published keeps its commit, and a chain workflow whose models the workspace lacks is left out.
 */
export async function publishRelease(deps: PublishDeps, publisher: Publisher, bundle: Bundle, models: readonly ModelInfo[]): Promise<PublishedSource[]> {
  const published: PublishedSource[] = [];
  for (const entry of (await bundle.index()).filter((row) => publishable(models, row.workflow))) {
    const { hash, tree } = await withRelease(models, entry, await bundle.tree(entry), published, workflowTimings(timings()));
    published.push(await publishSource(deps, publisher, entry.workflow, assetName(entry.workflow, publisher, hash), tree));
  }
  return published;
}
