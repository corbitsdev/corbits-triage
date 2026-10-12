import { describe, expect, test } from "bun:test";
import { projectQueue, type OpenPulls, type PullTriage } from "./hub-api.ts";
import { openItems, withPull, type Handled } from "./open-pulls.ts";

const KEY = "acme/widgets#8";

/** #8 as the hub answers it: a ready verdict from `runId`, which saw `ci`, and when author activity last started a run. */
function latest(runId: string, activityAt: string | null, ci = "success", facts: Record<string, unknown> = {}): PullTriage {
  const verdict = {
    runId, at: "2026-10-01T01:00:00.000Z", headSha: "a", settled: true, state: "ready-monitoring", actor: "author", humanGated: false,
    degraded: null, commented: false, checks: [], detail: { facts: { checks: ci, ...facts } },
  };
  return { repo: "acme/widgets", number: 8, activityAt, verdict, run: null };
}

function open(sha: string, numbers = [8]): OpenPulls {
  const prs = numbers.map((number) => ({ number, title: "Fix", author: "ada", draft: false, sha, updatedAt: "2026-10-01T00:00:00.000Z", labels: [] }));
  return { repos: [{ repo: "acme/widgets", prs }] } as OpenPulls;
}

const PUSHED = latest("run-1", "2026-10-01T00:00:00.000Z", "pending");

function marksOf(pull: PullTriage, pulls: OpenPulls, handled: Handled, held: Handled = {}) {
  return openItems(projectQueue([pull], [], pulls), handled, held).map((entry) => [entry.item.key, entry.handled]);
}

function approved(): Handled {
  const [item] = projectQueue([PUSHED], [], open("a"));
  if (item === undefined) throw new Error("no item");
  expect(item).toMatchObject({ ci: "pending", headSha: "a", activityAt: "2026-10-01T00:00:00.000Z" });
  return withPull({}, item, "approve");
}

describe("handled pull requests", () => {
  test("a newer verdict without author activity keeps the pull request handled", () => {
    expect(marksOf(latest("run-3", "2026-10-01T00:00:00.000Z"), open("a"), approved())).toEqual([[KEY, { kind: "approve" }]]);
  });

  test("a push or newer author activity brings the pull request back", () => {
    const handled = approved();
    expect(marksOf(PUSHED, open("b"), handled)).toEqual([[KEY, null]]);
    expect(marksOf(latest("run-2", "2026-10-01T01:00:00.000Z"), open("a"), handled)).toEqual([[KEY, null]]);
  });

  test("activity the hub has not recorded yet, or a head not read, keeps the pull request handled", () => {
    const [item] = projectQueue([latest("run-2", "2026-10-01T01:00:00.000Z")], [], open("a"));
    if (item === undefined) throw new Error("no item");
    expect(marksOf(PUSHED, open("a"), withPull({}, item, "approve"))).toEqual([[KEY, { kind: "approve" }]]);
    const failed: OpenPulls = { repos: [{ repo: "acme/widgets", prs: [], error: "rate limited" }] };
    expect(marksOf(PUSHED, failed, approved())).toEqual([[KEY, { kind: "approve" }]]);
  });

  test("a merge or close leaves both lists, held or sent", () => {
    const [item] = projectQueue([PUSHED], [], open("a"));
    if (item === undefined) throw new Error("no item");
    expect(marksOf(PUSHED, open("a"), withPull({}, item, "merge"))).toEqual([]);
    expect(marksOf(PUSHED, open("a"), {}, withPull({}, item, "close"))).toEqual([]);
  });

  test("an entry stored before kinds were recorded matches on the verdict run it answered", () => {
    expect(marksOf(PUSHED, open("a"), { [KEY]: "run-1" })).toEqual([[KEY, { kind: null }]]);
    expect(marksOf(latest("run-2", "2026-10-01T00:00:00.000Z"), open("a"), { [KEY]: "run-1" })).toEqual([[KEY, null]]);
  });
});

describe("answered reviews", () => {
  test("come from the newest verdict's facts", () => {
    const reviewed = latest("run-2", "2026-10-01T01:00:00.000Z", "success", { reviewAnswered: false });
    const answered = latest("run-3", "2026-10-01T01:00:00.000Z", "success", { reviewAnswered: true });
    expect(projectQueue([reviewed], [], open("a"))[0]?.reviewAnswered).toBe(false);
    expect(projectQueue([answered], [], open("a"))[0]?.reviewAnswered).toBe(true);
  });
});
