import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import type { PackState } from "./check-packs.ts";
import { projectQueue, type PrItem } from "./hub-api.ts";
import { groupInbox, regroupInbox } from "./inbox-view.ts";
import { mergeRepositories, packsPending, repoHealth, repoRows, triageReadyRepos } from "./repo-rows.ts";

function item(repo: string, number: number, extra: Partial<PrItem>): PrItem {
  return {
    key: `${repo}#${number}`, repo, number, title: null, author: null, authorKind: null, draft: null, mergeable: null, mergeBlock: null, state: "new",
    priority: null, owner: null, nextAction: null, verdict: null, score: null, reasons: [], evidence: [], checks: [], labels: [], comment: null,
    sha: null, verdictSha: null, degraded: null, needsHuman: false, closed: false, pendingApprovalId: null, runId: null, waitingSince: null, updatedAt: null,
    ci: null, headSha: null, activityAt: null, reviewAnswered: false, posted: false, running: false, failure: null, actions: [], href: "", ...extra,
  };
}

const repos = [
  { name: "acme/api", connected: true, enabled: true },
  { name: "acme/web", connected: true },
];

function read(found: PackState["found"]): PackState {
  return { found, pending: false, error: null };
}

function policyFile(repo: string): PackState {
  return read({ kind: "file", path: ".corbits-triage.yml", pack: recommendedPack(repo) });
}

const packs = new Map([["acme/api", policyFile("acme/api")], ["acme/web", read(null)]]);

describe("repository rows", () => {
  test("Needs you is the inbox's pile for the repository, and owners come from that pile", () => {
    const items = [
      item("acme/api", 1, { state: "needs-decision", owner: "Maintainer", updatedAt: "2026-10-01T00:00:00Z" }),
      item("acme/api", 2, { state: "ready", updatedAt: "2026-10-03T00:00:00Z" }),
      item("acme/api", 3, { state: "new", failure: "failed" }),
      item("acme/api", 4, { state: "new", owner: "Author", updatedAt: "2026-10-02T00:00:00Z" }),
    ];
    const pile = regroupInbox(groupInbox(items, triageReadyRepos(repos, packs)), "repo").find((group) => group.key === "acme/api");
    const [api] = repoRows(repos, packs, items, new Set(), new Set(), { repos: [{ repo: "acme/api", prs: [] }] }, null);
    expect(api).toMatchObject({
      href: "/repositories/acme/api",
      pulls: { open: 4, needsYou: pile?.items.length, awaiting: 1, owners: ["Maintainer", "Unassigned"], lastActivity: "2026-10-03T00:00:00Z" },
    });
    expect(pile?.items).toHaveLength(3);
  });

  test("only enabled repositories whose policy file runs count pull requests awaiting triage, and the inbox header and Settings agree", () => {
    const all = [...repos, { name: "acme/off", connected: true, enabled: false }, { name: "acme/raw", connected: true, enabled: true }, { name: "acme/loading", connected: true, enabled: true }];
    const states = new Map([...packs, ["acme/off", policyFile("acme/off")], ["acme/raw", read(null)], ["acme/loading", { found: null, pending: true, error: null }]]);
    const items = [
      item("acme/api", 1, {}),
      item("acme/api", 2, {}),
      item("acme/web", 3, {}),
      item("acme/web", 4, { state: "ready" }),
      item("acme/off", 5, {}),
      item("acme/raw", 6, {}),
      item("acme/loading", 7, {}),
    ];
    const rows = repoRows(all, states, items, new Set(), new Set(), undefined, null);
    expect(rows.map((row) => ("error" in row.pulls ? null : [row.pulls.awaiting, row.pulls.needsYou]))).toEqual([[2, 0], [0, 1], [0, 0], [0, 0], [0, 0]]);
    expect(groupInbox(items, triageReadyRepos(all, states)).awaiting).toBe(2);
    expect(triageReadyRepos(all, states)).toEqual(new Set(["acme/api"]));
    expect(packsPending(states)).toBe(true);
  });

  test("a GitHub failure replaces only the GitHub counts; setup still shows", () => {
    const listing = { repos: [{ repo: "acme/api", prs: [] }, { repo: "acme/web", prs: [], error: "rate limited" }] };
    const [api, web] = repoRows(repos, packs, [], new Set(), new Set(), listing, null);
    expect(api?.pulls).toMatchObject({ open: 0 });
    expect(web).toMatchObject({ href: "/repositories/acme/web", pulls: { error: "rate limited" }, health: { label: "Needs setup" } });
    const failed = repoRows(repos, packs, [], new Set(), new Set(["acme/api"]), undefined, new Error("offline"));
    expect(failed.map((row) => row.pulls)).toEqual([{ error: "offline" }, { error: "offline" }]);
    expect(failed[0]?.health.label).toBe("Catching up");
  });

  test("a repository whose policy file reads with a rule on is set up, with or without saved rules", () => {
    const states = new Map([
      ["acme/file", policyFile("acme/file")],
      ["acme/off", read({ kind: "file", path: ".corbits-triage.yml", pack: emptyPack("acme/off") })],
      ["acme/refused", read({ kind: "invalid", path: ".corbits-triage.yml", reason: "bad yaml" })],
      ["acme/none", read(null)],
      ["acme/loading", { found: null, pending: true, error: null }],
    ]);
    const all = [...states.keys()].map((name) => ({ name, connected: true, enabled: true }));
    const rows = repoRows(all, states, [], new Set(), new Set(), undefined, null);
    expect(rows.map((row) => [row.name, row.health.label === "Needs setup"])).toEqual([
      ["acme/file", false], ["acme/off", true], ["acme/refused", true], ["acme/none", true], ["acme/loading", false],
    ]);
  });

  test("GitHub's updatedAt reaches pull requests that already have a verdict", () => {
    const verdict = {
      runId: "run-1", at: "2026-10-01T00:30:00.000Z", headSha: "abc", verdict: "pass" as const, settled: true, state: "ready-monitoring", actor: "author", humanGated: false,
      degraded: null, commented: false, checks: [], detail: null,
    };
    const listing = { repos: [{ repo: "acme/api", prs: [{ number: 8, title: "PR 8", author: "ada", draft: false, sha: "abc", updatedAt: "2026-10-01T01:00:00.000Z", labels: [] }] }] };
    const items = projectQueue([{ repo: "acme/api", number: 8, activityAt: null, verdict, run: null }], [], listing);
    expect(items.find((row) => row.key === "acme/api#8")).toMatchObject({ runId: "run-1", updatedAt: "2026-10-01T01:00:00.000Z" });
  });

  test("health shows the first of setup, disabled, catching up, then webhooks", () => {
    const all = { needsSetup: true, enabled: false, catchingUp: true, receivingEvents: true };
    expect(repoHealth(all).label).toBe("Needs setup");
    expect(repoHealth({ ...all, needsSetup: false }).label).toBe("Disabled");
    expect(repoHealth({ ...all, needsSetup: false, enabled: true }).label).toBe("Catching up");
    expect(repoHealth({ ...all, needsSetup: false, enabled: true, catchingUp: false }).label).toBe("Webhooks OK");
    expect(repoHealth({ needsSetup: false, enabled: true, catchingUp: false, receivingEvents: false }).label).toBe("No events yet");
  });
});

describe("merged repositories", () => {
  test("a stored record wins over the Bitbucket Data Center listing, which only adds what is not recorded", () => {
    const stored = [{ name: "TRI/widgets", connected: true, source: "bitbucket-datacenter" as const, enabled: true, checkPack: { name: "check-pack/TRI/widgets" } }];
    const listed = [
      { name: "TRI/widgets", connected: true, source: "bitbucket-datacenter" as const, enabled: false },
      { name: "TRI/gadgets", connected: true, source: "bitbucket-datacenter" as const, enabled: false },
    ];
    expect(mergeRepositories(stored, listed)).toEqual([stored[0]!, listed[1]!]);
  });
});
