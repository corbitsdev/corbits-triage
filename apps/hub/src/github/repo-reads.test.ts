import { expect, test } from "bun:test";
import { GithubRateLimited } from "./github-usage.js";
import { keptOpenPrs } from "./open-pulls.js";
import { createRepoReads, KEPT_MS } from "./repo-reads.js";

const TENANT = "tnt_1";
const REPO = "acme/widgets";

test("a GitHub repository is listed again only after a webhook about its pull requests or once its listing is the kept age", async () => {
  let at = 0;
  const reads = createRepoReads(() => new Date(at));
  const listed: string[] = [];
  const list = keptOpenPrs(async function listNow(_tenantId, record) {
    listed.push(record.name);
    return [];
  }, reads);
  const github = { name: REPO, connected: true };
  const bitbucket = { name: "ACME/widgets", source: "bitbucket-datacenter" as const, connected: true };
  async function poll() {
    await Promise.all([list(TENANT, github), list(TENANT, github), list(TENANT, bitbucket)]);
  }

  await poll();
  await poll();
  reads.changed(TENANT, REPO, "check_run");
  await poll();
  expect(listed).toEqual([REPO, "ACME/widgets", "ACME/widgets", "ACME/widgets"]);

  reads.changed(TENANT, REPO, "pull_request");
  await poll();
  at = KEPT_MS.pulls;
  await poll();
  expect(listed.filter((name) => name === REPO)).toHaveLength(3);
});

test("an unusable or rate-limited read is read again, and a change during a read leaves its answer unkept", async () => {
  const reads = createRepoReads(() => new Date(0));
  let calls = 0;
  let release = function none() {};
  const answers: Array<() => Promise<string>> = [
    async function unusable() {
      return "computing";
    },
    async function failed(): Promise<string> {
      throw new GithubRateLimited("42", 60_000);
    },
    function slow() {
      return new Promise<string>(function wait(resolve) {
        release = function done() {
          resolve("before the change");
        };
      });
    },
    async function fresh() {
      return "after the change";
    },
  ];
  function worked(value: string) {
    return value !== "computing";
  }
  function read() {
    return reads.read({ scope: "all", tenantId: TENANT, repo: REPO, key: "details:1", usable: worked }, function readNow() {
      return answers[calls++]!();
    });
  }

  expect(await read()).toBe("computing");
  await expect(read()).rejects.toBeInstanceOf(GithubRateLimited);
  const during = read();
  reads.changed(TENANT, REPO, "status");
  release();
  expect(await during).toBe("before the change");
  expect(await read()).toBe("after the change");
  expect(await read()).toBe("after the change");
  expect(calls).toBe(4);
});
