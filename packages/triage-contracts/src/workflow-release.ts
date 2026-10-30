import { CODE_REVIEW_PROVIDERS } from "./code-review-models.js";
import type { RepoSource } from "./repo-source.js";

/** The catalog provider that serves the decision model. */
export const INFERENCE_PROVIDER = "corbits-system-one";
/** Catalog model the triage workflows declare; its offering carries the provider's own model name. */
export const DECISION_MODEL_ALIAS = "decision";
export const ANTHROPIC_PROVIDER = "anthropic";

/** The models Triage's workflows name, each with the catalog provider that serves it. */
export const DECLARED_MODELS = [
  { model: DECISION_MODEL_ALIAS, provider: INFERENCE_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.smart, provider: ANTHROPIC_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.fast, provider: ANTHROPIC_PROVIDER },
] as const;

type DeclaredModel = (typeof DECLARED_MODELS)[number]["model"];

/** Where a release's workflow comes from: the package under packages/ and its entry, built into its own package. */
export type BuiltPackage = {
  /** The workflow's name, which its hub address and deployment go by whatever package it comes from. */
  name: string;
  workspace: string;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
  /** The catalog models the workflow's agents name; the first is its default source. */
  models: readonly [DeclaredModel, ...DeclaredModel[]];
};

/** A workflow of the manager chain; one that deploys others is published after them, with each release under `as`. */
type ChainPackage = BuiltPackage & { source: RepoSource; deploys?: readonly { workflow: string; as: "codeReview" | "manager" | "judge" }[] };

// Each host's listener deploys its manager, which deploys its code review and its judge, so they publish in this order.
export const CHAIN_PACKAGES = [
  { name: "pr-code-review-reviewer-github", workspace: "pr-code-review-anthropic", source: "github", packageName: "@corbits/pr-code-review-reviewer-github-workflow", entry: "./pr-code-review-reviewer-github.mjs", src: "src/pr-code-review-reviewer-github.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-code-review-reviewer-bitbucket-datacenter", workspace: "pr-code-review-anthropic", source: "bitbucket-datacenter", packageName: "@corbits/pr-code-review-reviewer-bitbucket-datacenter-workflow", entry: "./pr-code-review-reviewer-bitbucket-datacenter.mjs", src: "src/pr-code-review-reviewer-bitbucket-datacenter.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "triage-judge-github", workspace: "triage-judge", source: "github", packageName: "@corbits/triage-judge-github-workflow", entry: "./triage-judge-github.mjs", src: "src/triage-judge-github.ts", models: ["decision"] },
  { name: "triage-judge-bitbucket-datacenter", workspace: "triage-judge", source: "bitbucket-datacenter", packageName: "@corbits/triage-judge-bitbucket-datacenter-workflow", entry: "./triage-judge-bitbucket-datacenter.mjs", src: "src/triage-judge-bitbucket-datacenter.ts", models: ["decision"] },
  { name: "triage-manager-github", workspace: "triage-manager", source: "github", packageName: "@corbits/triage-manager-github-workflow", entry: "./triage-manager-github.mjs", src: "src/triage-manager-github.ts", models: ["decision"], deploys: [{ workflow: "pr-code-review-reviewer-github", as: "codeReview" }, { workflow: "triage-judge-github", as: "judge" }] },
  { name: "triage-manager-bitbucket-datacenter", workspace: "triage-manager", source: "bitbucket-datacenter", packageName: "@corbits/triage-manager-bitbucket-datacenter-workflow", entry: "./triage-manager-bitbucket-datacenter.mjs", src: "src/triage-manager-bitbucket-datacenter.ts", models: ["decision"], deploys: [{ workflow: "pr-code-review-reviewer-bitbucket-datacenter", as: "codeReview" }, { workflow: "triage-judge-bitbucket-datacenter", as: "judge" }] },
  { name: "triage-listener-github", workspace: "triage-manager", source: "github", packageName: "@corbits/triage-listener-github-workflow", entry: "./triage-listener-github.mjs", src: "src/triage-listener-github.ts", models: ["decision"], deploys: [{ workflow: "triage-manager-github", as: "manager" }] },
  { name: "triage-listener-bitbucket-datacenter", workspace: "triage-manager", source: "bitbucket-datacenter", packageName: "@corbits/triage-listener-bitbucket-datacenter-workflow", entry: "./triage-listener-bitbucket-datacenter.mjs", src: "src/triage-listener-bitbucket-datacenter.ts", models: ["decision"], deploys: [{ workflow: "triage-manager-bitbucket-datacenter", as: "manager" }] },
] as const satisfies readonly ChainPackage[];

/** A release's workflow as a source tree: `sources/<workflow>-<hash>.json`, where `hash` is its build's content hash. */
export type SourceIndexEntry = { workflow: string; hash: string };
/** Each file's path in the source asset mapped to its contents. */
export type SourceTree = Record<string, string>;

/** A model the workspace's catalog resolves, with the offering each provider serves it through. */
export type ModelInfo = { canonicalName: string; offerings: Array<{ offeringId: string; providerName: string }> };

export type Offerings = { ids: string[]; defaultId: string };

/** A workflow published as a source asset at one commit. */
export type PublishedSource = { workflow: string; assetId: string; commitSha: string };

export function chainOf(workflow: string): ChainPackage | undefined {
  return CHAIN_PACKAGES.find((row) => row.name === workflow);
}

/** Whether a chain workflow deploys this one, under its creator's read on this one's asset. */
export function deployedByChain(workflow: string): boolean {
  return CHAIN_PACKAGES.some((row: ChainPackage) => row.deploys?.some((slot) => slot.workflow === workflow) === true);
}

function offeringOf(models: readonly ModelInfo[], name: DeclaredModel): string | undefined {
  const declared = DECLARED_MODELS.find((row) => row.model === name);
  return models.find((model) => model.canonicalName === name)?.offerings.find((o) => o.providerName === declared?.provider)?.offeringId;
}

/** The offering of each model a workflow names, its first model's the default; undefined while the workspace lacks any of them. */
export function offeringsIn(models: readonly ModelInfo[], names: readonly [DeclaredModel, ...DeclaredModel[]]): Offerings | undefined {
  const ids: string[] = [];
  for (const name of names) {
    const id = offeringOf(models, name);
    if (!id) return undefined;
    ids.push(id);
  }
  return { ids, defaultId: ids[0]! };
}

/** A chain workflow publishes only while the workspace has every model it names; the others always publish. */
export function publishable(models: readonly ModelInfo[], workflow: string): boolean {
  const chain = chainOf(workflow);
  return !chain || offeringsIn(models, chain.models) !== undefined;
}

async function hex8(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A chain workflow's tree carries the release of each workflow it deploys, published before it, and its hash covers
 * the build and that release together, so the same build with other offerings publishes a new asset. A workflow left
 * out for a missing model, such as code review in a workspace without its model, is omitted from the release; when
 * every one was, the tree keeps the build's empty release. Any other gap is an ordering mistake and fails the publish.
 */
export async function withRelease(models: readonly ModelInfo[], entry: SourceIndexEntry, tree: SourceTree, published: readonly PublishedSource[]): Promise<{ hash: string; tree: SourceTree }> {
  const plain = { hash: entry.hash, tree };
  const chain = chainOf(entry.workflow);
  if (!chain?.deploys) return plain;
  const file = `packages/${entry.workflow}/release.json`;
  if (!(file in tree)) throw new Error(`The build's ${entry.workflow} does not read a release.`);
  const body: Record<string, unknown> = {};
  for (const slot of chain.deploys) {
    const deployed = published.find((row) => row.workflow === slot.workflow);
    if (!deployed && !publishable(models, slot.workflow)) continue;
    const target = chainOf(slot.workflow);
    const offerings = target && offeringsIn(models, target.models);
    if (!deployed || !target || !offerings) throw new Error(`${entry.workflow} deploys ${slot.workflow}, which this release has not published before it.`);
    const release = { name: slot.workflow, workflow: { assetId: deployed.assetId, commitSha: deployed.commitSha, packageName: target.packageName, entry: target.entry }, offerings };
    if (slot.as === "codeReview") {
      const reviewers = (body["codeReviews"] ??= {}) as Record<string, unknown>;
      reviewers[slot.workflow] = release;
    } else body[slot.as] = release;
  }
  if (Object.keys(body).length === 0) return plain;
  const json = `${JSON.stringify({ [chain.source]: body }, null, 2)}\n`;
  return { hash: await hex8(`${entry.hash}\n${json}`), tree: { ...tree, [file]: json } };
}
