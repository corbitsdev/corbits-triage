import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import { repoRows } from "./repo-rows.ts";

function item(repo: string, number: number, extra: Partial<PrItem>): PrItem {
  return {
    key: `${repo}#${number}`, repo, number, title: null, author: null, draft: null, mergeable: null, state: "new",
    priority: null, owner: null, nextAction: null, confidence: null, evidence: [], checks: [], labels: [], comment: null,
    sha: null, degraded: null, needsHuman: false, closed: false, pendingApprovalId: null, runId: null, waitingSince: null,
    canClose: false, pendingClose: false, href: "", ...extra,
  };
}

describe("repository rows", () => {
  test("counts, owners and activity come from the repository's open items only", () => {
    const repos = [
      { name: "acme/api", connected: true, enabled: true, cleanupMode: "automated" as const, checkPack: { name: "check-pack/acme/api" } },
      { name: "acme/web", connected: true },
    ];
    const items = [
      item("acme/api", 1, { needsHuman: true, owner: "Maintainer", waitingSince: "2026-10-01T00:00:00Z" }),
      item("acme/api", 2, { owner: "Author", waitingSince: "2026-10-03T00:00:00Z" }),
      item("acme/api", 3, { owner: "Maintainer", waitingSince: "2026-10-02T00:00:00Z" }),
      item("acme/api", 4, { closed: true, owner: "Reviewer", waitingSince: "2026-10-05T00:00:00Z" }),
    ];
    const [api, web] = repoRows(repos, items, [], []);
    expect(api).toMatchObject({
      href: "/repositories/acme%2Fapi",
      open: 3,
      needsYou: 1,
      posting: "Post automatically",
      owners: ["Maintainer", "Author"],
      lastActivity: "2026-10-03T00:00:00Z",
      health: { tone: "idle", label: "No webhooks yet" },
    });
    expect(web).toMatchObject({
      href: "/repositories/acme%2Fweb/setup",
      open: 0,
      posting: "Ask me",
      owners: [],
      lastActivity: null,
      health: { tone: "warn", label: "Needs setup" },
    });
  });
});
