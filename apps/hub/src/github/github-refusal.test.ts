import { expect, test } from "bun:test";
import { githubFailed } from "./github-refusal.js";

test("a refusal keeps the status and GitHub's reason, never the method or path", async () => {
  const err = new Error("github PUT /repos/acme/widgets/pulls/8/merge -> 405 At least 1 approving review is required by reviewers with write access.");
  const res = githubFailed("merge acme/widgets#8", err);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: { code: "github_failed", message: "GitHub refused to merge acme/widgets#8 (HTTP 405): At least 1 approving review is required by reviewers with write access." } });
});
