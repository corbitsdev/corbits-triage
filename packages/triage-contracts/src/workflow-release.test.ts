import { expect, test } from "bun:test";
import { CODE_REVIEW_REVIEWERS } from "./code-review-models.js";
import { CHAIN_PACKAGES, DECLARED_MODELS, withRelease } from "./workflow-release.js";

test.each(["github", "bitbucket-datacenter"] as const)("the %s manager release binds the mapped reviewer to its published asset", async (source) => {
  const reviewer = CODE_REVIEW_REVIEWERS.anthropic[source];
  const manager = `triage-manager-${source}`;
  const file = `packages/${manager}/release.json`;
  const models = DECLARED_MODELS.map(({ model, provider }) => ({ canonicalName: model, offerings: [{ offeringId: `off_${model}`, providerName: provider }] }));
  const published = [{ workflow: reviewer, assetId: "ast_review", commitSha: "sha_review" }, { workflow: `triage-judge-${source}`, assetId: "ast_judge", commitSha: "sha_judge" }];
  const result = await withRelease(models, { workflow: manager, hash: "build" }, { [file]: "{}" }, published);
  expect(JSON.parse(result.tree[file]!)[source].codeReviews[reviewer]).toMatchObject({ name: reviewer, workflow: { assetId: "ast_review", commitSha: "sha_review", entry: `./${reviewer}.mjs` } });
});

test.each(["github", "bitbucket-datacenter"] as const)("the %s release retains every reviewer and fails on a missing published asset", async (source) => {
  const chain = CHAIN_PACKAGES as unknown as Array<{ name: string; source: string; models: readonly string[]; packageName: string; entry: string; deploys?: Array<{ workflow: string; as: string }> }>;
  const original = chain.find((row) => row.name === CODE_REVIEW_REVIEWERS.anthropic[source])!;
  const manager = chain.find((row) => row.name === `triage-manager-${source}`)!;
  const second = { ...original, name: `fixture-reviewer-${source}`, entry: `./fixture-reviewer-${source}.mjs` };
  chain.push(second);
  manager.deploys!.push({ workflow: second.name, as: "codeReview" });
  try {
    const models = DECLARED_MODELS.map(({ model, provider }) => ({ canonicalName: model, offerings: [{ offeringId: `off_${model}`, providerName: provider }] }));
    const file = `packages/${manager.name}/release.json`;
    const published = [{ workflow: original.name, assetId: "ast_first", commitSha: "sha_first" }, { workflow: second.name, assetId: "ast_second", commitSha: "sha_second" }, { workflow: `triage-judge-${source}`, assetId: "ast_judge", commitSha: "sha_judge" }];
    const result = await withRelease(models, { workflow: manager.name, hash: "build" }, { [file]: "{}" }, published);
    expect(JSON.parse(result.tree[file]!)[source].codeReviews).toMatchObject({ [original.name]: { workflow: { assetId: "ast_first" } }, [second.name]: { workflow: { assetId: "ast_second" } } });
    await expect(withRelease(models, { workflow: manager.name, hash: "build" }, { [file]: "{}" }, published.filter((row) => row.workflow !== second.name))).rejects.toThrow("has not published before it");
  } finally {
    manager.deploys!.pop();
    chain.pop();
  }
});
