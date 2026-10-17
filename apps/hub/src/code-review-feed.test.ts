import { expect, test } from "bun:test";
import type { RepoSource } from "@corbits/triage-contracts";
import { createCodeReviewFeed, cutDiff, type PullRequestToReview } from "./code-review-feed.js";
import type { TriageJob } from "./github/coordinator.js";
import type { PrMail } from "./github/normalize.js";
import type { RepoRecord } from "./github/tenant-config.js";

const RECORD: RepoRecord = { name: "acme/widgets", connected: true, codeReview: true };
const PULL: PullRequestToReview = { title: "Fix", description: "Body", headSha: "sha1", draft: false, open: true, diff: "diff --git a/x b/x\n+1\n" };

function mail(action: string, fields: Partial<PrMail> = {}): PrMail {
  return { kind: "pr", repo: RECORD.name, prNumber: 7, deliveryId: "d", event: "pull_request", action, headSha: "sha1", author: "a", title: "Fix", body: "Body", draft: false, review: null, ...fields };
}

function harness(reviewed: RepoSource[] = ["github"], pull = PULL) {
  const sent: TriageJob[] = [];
  const feed = createCodeReviewFeed({
    reviewed: async () => reviewed,
    read: async () => pull,
    async send(job) {
      sent.push(job);
    },
    log() {},
  });
  return { feed, sent };
}

test("each new non-draft head is sent to its host's code review once; Review again sends it anyway", async () => {
  const { feed, sent } = harness();
  await feed.offer("t", RECORD, mail("synchronize"));
  await feed.offer("t", RECORD, mail("synchronize"));
  await feed.offer("t", RECORD, mail("labeled"));
  await feed.offer("t", RECORD, mail("opened", { draft: true }));
  expect(sent).toEqual([{
    tenantId: "t",
    workflow: "pr-code-review-github",
    repo: "acme/widgets",
    number: 7,
    headSha: "sha1",
    source: "event",
    payload: { kind: "code-review", title: "Fix", description: "Body", diff: PULL.diff, checkout: { source: "github", repo: "acme/widgets", sha: "sha1" } },
  }]);
  expect(await feed.again("t", RECORD, 7)).toBe("sent");
  expect(sent.map((job) => job.source)).toEqual(["event", "retry"]);
});

test("nothing is sent while code review is off, the key is missing or the pull request turned draft", async () => {
  expect(await harness([]).feed.again("t", RECORD, 7)).toBe("not_reviewed");
  expect(await harness().feed.again("t", { ...RECORD, codeReview: false }, 7)).toBe("not_reviewed");
  expect(await harness(["github"], { ...PULL, draft: true }).feed.again("t", RECORD, 7)).toBe("draft");
});

test("a diff over the limit is cut at a line boundary and says how much it kept", () => {
  expect(cutDiff("a\nb\n", 10)).toEqual({ diff: "a\nb\n" });
  expect(cutDiff("aaa\nbbb\nccc\n", 9)).toEqual({ diff: "aaa\nbbb\n", cut: { lines: 2, of: 3 } });
  expect(cutDiff("abcdefgh\n", 4)).toEqual({ diff: "abcd", cut: { lines: 1, of: 1 } });
});

test("a host answer that is not a unified diff is refused, not reviewed", async () => {
  const { feed, sent } = harness(["github"], { ...PULL, diff: "{\"url\":\"…\"}" });
  await expect(feed.again("t", RECORD, 7)).rejects.toThrow("the host returned no unified diff");
  expect(sent).toEqual([]);
});

test("two deliveries of one push in flight together send it once, and a head whose worker failed is sent again", async () => {
  const sent: TriageJob[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const feed = createCodeReviewFeed({
    reviewed: async () => ["github"],
    read: async () => PULL,
    async send(job) {
      sent.push(job);
      await held;
    },
    log() {},
  });
  const first = feed.offer("t", RECORD, mail("synchronize", { headSha: null }));
  const second = feed.offer("t", RECORD, mail("synchronize", { headSha: null }));
  release();
  await Promise.all([first, second]);
  expect(sent).toHaveLength(1);

  feed.forget(sent[0]!);
  await feed.offer("t", RECORD, mail("synchronize"));
  expect(sent).toHaveLength(2);
});
