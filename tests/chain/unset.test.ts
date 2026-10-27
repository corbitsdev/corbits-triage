// A repository with no policy file, until one is added.
import { expect, test } from "bun:test";
import { POLICY_FILE_PATH, VERDICT_LABELS } from "@corbits/triage-contracts";
import { deliver } from "./stack.ts";
import { chainStack, UNSET, MAX_FILES, policy, sha, pullOf, comments, labelled, once } from "./chain.ts";

const chain = chainStack();
const { github, pushed, claimOf, managers, settled } = chain;

const unset = once(async function unset() {
  const head = sha("unset-1");
  const [before, missed] = [(await managers()).length, github.misses.length];
  await pushed(UNSET, pullOf(1, head));
  // The hub answers a pull request without a policy file at once, so a short wait shows a manager it should not have deployed.
  await Bun.sleep(5_000);
  const withoutFile = { claim: await claimOf(UNSET, 1), deployed: (await managers()).slice(before), writes: [...github.writesTo(UNSET, 1)] };
  github.setPolicy(UNSET, policy([MAX_FILES]));
  await deliver(chain.hub, chain.workspace, "push", {
    ref: "refs/heads/main", installation: { id: 1 }, repository: { full_name: UNSET, default_branch: "main" },
    commits: [{ added: [POLICY_FILE_PATH], modified: [], removed: [] }],
  });
  await settled(UNSET, 1);
  return { withoutFile, deployed: (await managers()).slice(before), writes: github.writesTo(UNSET, 1), misses: github.misses.slice(missed) };
});

test("a repository with no policy file gets no manager, and adding the file triages its open pull requests", async () => {
  const { withoutFile, deployed, writes, misses } = await unset();
  expect(withoutFile).toEqual({ claim: undefined, deployed: [], writes: [] });
  expect(misses).toEqual([]);
  expect(deployed).toHaveLength(1);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});
