import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import { repoRows } from "./repo-rows.ts";

function item(repo: string, number: number, extra: Partial<PrItem>): PrItem {
  return {
    key: `${repo}#${number}`, repo, number, title: null, author: null, draft: null, mergeable: null, state: "new",
    priority: null, owner: null, nextAction: null, confidence: null, evidence: [], checks: [], labels: [], comment: null,
    sha: null, degraded: null, needsHuman: false, closed: false, pendingApprovalId: null, runId: null, waitingSince: null, updatedAt: null,
    canClose: false, pendingClose: false, href: "", ...extra,
  };
}

describe("repository rows", () => {
  test("counts, owners and GitHub activity come from the repository's open items only", () => {
    const repos = [
      { name: "acme/api", connected: true, enabled: true, cleanupMode: "automated" as const, checkPack: { name: "check-pack/acme/api" } },
      { name: "acme/web", connected: true },
    ];
    const items = [
      item("acme/api", 1, { needsHuman: true, owner: "Maintainer", updatedAt: "2026-10-01T00:00:00Z" }),
      item("acme/api", 2, { owner: "Author", updatedAt: "2026-10-03T00:00:00Z" }),
      item("acme/api", 3, { owner: "Maintainer", updatedAt: "2026-10-02T00:00:00Z" }),
      item("acme/api", 4, { closed: true, owner: "Reviewer", updatedAt: "2026-10-05T00:00:00Z" }),
    ];
    const openPulls = { repos: [{ repo: "acme/api", prs: [] }, { repo: "acme/web", prs: [], error: "rate limited" }] };
    const [api, web] = repoRows(repos, items, [], [], openPulls);
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
      lastActivity: undefined,
      health: { tone: "warn", label: "Needs setup" },
    });
  });
});
