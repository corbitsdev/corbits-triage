import { expect, test } from "bun:test";
import { CODE_REVIEW_REVIEWERS } from "./code-review-models.js";
import { DECLARED_MODELS, withRelease } from "./workflow-release.js";

test.each(["github", "bitbucket-datacenter"] as const)("the %s manager release binds the mapped reviewer to its published asset", async (source) => {
  const reviewer = CODE_REVIEW_REVIEWERS.anthropic[source];
  const manager = `triage-manager-${source}`;
  const file = `packages/${manager}/release.json`;
  const models = DECLARED_MODELS.map(({ model, provider }) => ({ canonicalName: model, offerings: [{ offeringId: `off_${model}`, providerName: provider }] }));
  const published = [{ workflow: reviewer, assetId: "ast_review", commitSha: "sha_review" }, { workflow: `triage-judge-${source}`, assetId: "ast_judge", commitSha: "sha_judge" }];
  const result = await withRelease(models, { workflow: manager, hash: "build" }, { [file]: "{}" }, published);
  expect(JSON.parse(result.tree[file]!)[source].codeReview).toMatchObject({ name: reviewer, workflow: { assetId: "ast_review", commitSha: "sha_review", entry: `./${reviewer}.mjs` } });
});
