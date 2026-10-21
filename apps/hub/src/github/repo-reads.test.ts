import { expect, test } from "bun:test";
import { keptOpenPrs } from "./open-pulls.js";
import { createRepoReads, SAFETY_MS } from "./repo-reads.js";

test("a GitHub repository is listed again only after a webhook about its pull requests or once its listing is the safety interval old", async () => {
  let at = 0;
  const reads = createRepoReads(() => new Date(at));
  const listed: string[] = [];
  const list = keptOpenPrs(async function listNow(_tenantId, record) {
    listed.push(record.name);
    return [];
  }, reads);
  const github = { name: "acme/widgets", connected: true };
  const bitbucket = { name: "ACME/widgets", source: "bitbucket-datacenter" as const, connected: true };
  async function poll() {
    await Promise.all([list("tnt_1", github), list("tnt_1", github), list("tnt_1", bitbucket)]);
  }

  await poll();
  await poll();
  reads.changed("tnt_1", "acme/widgets", "check_run");
  await poll();
  expect(listed).toEqual(["acme/widgets", "ACME/widgets", "ACME/widgets", "ACME/widgets"]);

  reads.changed("tnt_1", "acme/widgets", "pull_request");
  await poll();
  at = SAFETY_MS;
  await poll();
  expect(listed.filter((name) => name === "acme/widgets")).toHaveLength(3);
});
