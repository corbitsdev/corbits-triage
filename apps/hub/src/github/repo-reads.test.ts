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
  const list = keptOpenPrs(() => async function listNow(record) {
    listed.push(record.name);
    return [];
  }, reads)(TENANT);
  const github = { name: REPO, connected: true };
  const bitbucket = { name: "ACME/widgets", source: "bitbucket-datacenter" as const, connected: true };
  async function poll() {
    await Promise.all([list(github), list(github), list(bitbucket)]);
  }

  await poll();
  await poll();
  reads.changed(TENANT, REPO, "github", "check_run");
  await poll();
  expect(listed).toEqual([REPO, "ACME/widgets", "ACME/widgets", "ACME/widgets"]);

  reads.changed(TENANT, REPO, "github", "pull_request");
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
    return reads.read({ scope: "all", tenantId: TENANT, repo: REPO, source: "github", key: "details:1", usable: worked }, function readNow() {
      return answers[calls++]!();
    });
  }

  expect(await read()).toBe("computing");
  await expect(read()).rejects.toBeInstanceOf(GithubRateLimited);
  const during = read();
  reads.changed(TENANT, REPO, "github", "status");
  release();
  expect(await during).toBe("before the change");
  expect(await read()).toBe("after the change");
  expect(await read()).toBe("after the change");
  expect(calls).toBe(4);
});

test("a change on GitHub does not drop the Bitbucket read of the same repository name", async () => {
  const reads = createRepoReads(() => new Date(0));
  let githubReads = 0;
  let bitbucketReads = 0;
  function read(source: "github" | "bitbucket-datacenter", next: () => number) {
    return reads.read({ scope: "all", tenantId: TENANT, repo: REPO, source, key: "details:1" }, async function readNow() {
      return next();
    });
  }

  expect(await read("github", () => ++githubReads)).toBe(1);
  expect(await read("bitbucket-datacenter", () => ++bitbucketReads)).toBe(1);
  reads.changed(TENANT, REPO, "github", "pull_request");
  expect(await read("github", () => ++githubReads)).toBe(2);
  expect(await read("bitbucket-datacenter", () => ++bitbucketReads)).toBe(1);
  expect(bitbucketReads).toBe(1);
});
