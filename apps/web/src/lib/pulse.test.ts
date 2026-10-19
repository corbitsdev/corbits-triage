import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import type { OpenItem } from "./inbox-view.ts";
import { CONTINUE_MS, parseSavedPulse, resumeVisit, sinceVisit, stuckPulls, visitOf, type Visit } from "./pulse.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const READ = new Set(["acme/api", "acme/web"]);

function open(key: string, overrides: Partial<PrItem> = {}, handled: OpenItem["handled"] = null): OpenItem {
  const item = {
    key, repo: key.slice(0, key.indexOf("#")), number: Number(key.slice(key.indexOf("#") + 1)), title: `Title ${key}`, state: "needs-decision",
    draft: false, pendingApprovalId: null, actions: [], ci: null, failure: null, waitingSince: "2026-10-09T12:00:00.000Z", ...overrides,
  } as PrItem;
  return { item, handled };
}

describe("sinceVisit", () => {
  const visit: Visit = {
    at: "2026-10-09T12:00:00.000Z",
    repos: ["acme/api", "acme/web"],
    pulls: {
      "acme/api#1": { title: "Kept", you: false },
      "acme/api#2": { title: "Merged", you: true },
      "acme/web#3": { title: "Read failed", you: true },
    },
  };

  test("counts new, resolved and turned to you only in repositories compared both times", () => {
    const now = [open("acme/api#1"), open("acme/api#4"), open("acme/new#5")];
    const since = sinceVisit(visit, now, new Set(["acme/api", "acme/new"]));
    expect(since.fresh.map((item) => item.key)).toEqual(["acme/api#4"]);
    expect(since.resolved).toEqual([{ key: "acme/api#2", repo: "acme/api", number: 2, title: "Merged", url: null }]);
    expect(since.turned.map((item) => item.key)).toEqual(["acme/api#1"]);
  });

  test("a pull request handed to the author is not turned to you", () => {
    expect(sinceVisit(visit, [open("acme/api#1", {}, { kind: "changes" })], READ).turned).toEqual([]);
  });

  test("the visit taken now shows no change", () => {
    const now = [open("acme/api#1"), open("acme/web#3", {}, { kind: "changes" })];
    const since = sinceVisit(visitOf(now, READ, new Date(NOW)), now, READ);
    expect([since.fresh, since.resolved, since.turned]).toEqual([[], [], []]);
  });
});

describe("stuckPulls", () => {
  test("lists pull requests waiting on the maintainer longer than 3 days, oldest first", () => {
    const stuck = stuckPulls([
      open("acme/api#1", { waitingSince: "2026-10-07T11:00:00.000Z" }),
      open("acme/api#2", { waitingSince: "2026-10-01T00:00:00.000Z" }),
      open("acme/api#3", { waitingSince: "2026-10-07T13:00:00.000Z" }),
      open("acme/api#4", { waitingSince: "2026-10-01T00:00:00.000Z" }, { kind: "changes" }),
      open("acme/api#5", { waitingSince: null }),
    ], NOW);
    expect(stuck.map((item) => item.key)).toEqual(["acme/api#2", "acme/api#1"]);
  });
});

describe("resumeVisit", () => {
  const compared = visitOf([open("acme/api#1")], READ, new Date(NOW - 86_400_000));
  const latest = visitOf([open("acme/api#1"), open("acme/api#2")], READ, new Date(NOW));
  const saved = { compared, latest, acted: ["acme/api#1"], first: false };

  test("a reload or restored tab within 10 minutes of the last save carries the visit on", () => {
    expect(resumeVisit(saved, NOW + CONTINUE_MS - 1)).toEqual({ compared, acted: ["acme/api#1"], first: false });
  });

  test("later, the last save is what the new visit is compared to", () => {
    expect(resumeVisit(saved, NOW + CONTINUE_MS)).toEqual({ compared: latest, acted: [], first: false });
  });
});

describe("parseSavedPulse", () => {
  test("reads back a saved pulse and rejects anything else", () => {
    const visit = visitOf([open("acme/api#1")], READ, new Date(NOW));
    const saved = { compared: visit, latest: visit, acted: [], first: true };
    expect(parseSavedPulse(JSON.stringify(saved))).toEqual(saved);
    expect(parseSavedPulse(JSON.stringify(visit))).toBeNull();
    expect(parseSavedPulse("not json")).toBeNull();
    expect(parseSavedPulse(null)).toBeNull();
  });
});
