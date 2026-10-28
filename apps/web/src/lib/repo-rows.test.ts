import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import type { PackState } from "./check-packs.ts";
import { projectQueue, type OpenPulls, type PrItem, type RepoRecord } from "./hub-api.ts";
import { groupInbox, regroupInbox } from "./inbox-view.ts";
import { findRepo, hostedRepos, mergeRepositories, packsPending, repoHealth, repoRows, selectedRepo, triageReadyRepos } from "./repo-rows.ts";

function item(repo: string, number: number, extra: Partial<PrItem>): PrItem {
  const base: PrItem = {
    key: `${repo}#${number}`, repo, number, title: null, author: null, authorKind: null, byTriage: false,
    draft: null, mergeable: null, mergeBlock: null, state: "new",
    priority: null, owner: null, nextAction: null, verdict: null, score: null, reasons: [], evidence: [], checks: [], labels: [], comment: null,
    sha: null, verdictSha: null, degraded: null, needsHuman: false, closed: false, pendingApprovalId: null, runId: null, waitingSince: null, updatedAt: null,
    ci: null, headSha: null, activityAt: null, reviewAnswered: false, posted: false, running: false, waitingForCi: false, waitingHeadSha: null, awaiting: [],
    failure: null, actions: [], automatic: [], href: "", source: "github", url: null,
  };
  return Object.assign(base, extra);
}

function repoRecord(name: string, enabled?: boolean): RepoRecord {
  return { name, connected: true, source: "github", ...(enabled !== undefined && { enabled }) };
}

const repos = [
  repoRecord("acme/api", true),
  repoRecord("acme/web"),
];

function read(found: PackState["found"]): PackState {
  return { found, pending: false, error: null };
}

function policyFile(repo: string): PackState {
  return read({ kind: "file", path: ".corbits-triage.yml", pack: recommendedPack(repo) });
}

function twoHosts(github: number[], bitbucket: number[]): OpenPulls {
  function prs(numbers: number[]) {
    return numbers.map((number) => ({ number, title: `PR ${number}`, author: "ada", draft: false, sha: `sha${number}`, updatedAt: "2026-10-01T00:00:00.000Z", labels: [] }));
  }
  return { repos: [{ repo: "acme/api", prs: prs(github) }, { repo: "acme/api", source: "bitbucket-datacenter", prs: prs(bitbucket) }] };
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
    const [api] = repoRows(repos, packs, items, [], [], { repos: [{ repo: "acme/api", prs: [] }] }, null);
    expect(api).toMatchObject({
      href: "/repositories/acme/api",
      pulls: { open: 4, needsYou: pile?.items.length, awaiting: 1, owners: ["Maintainer", "Unassigned"], lastActivity: "2026-10-03T00:00:00Z" },
    });
    expect(pile?.items).toHaveLength(3);
  });

  test("only enabled repositories whose policy file runs count pull requests awaiting triage, and the inbox header and Settings agree", () => {
    const all = [...repos, repoRecord("acme/off", false), repoRecord("acme/raw", true), repoRecord("acme/loading", true)];
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
    const rows = repoRows(all, states, items, [], [], undefined, null);
    expect(rows.map((row) => ("error" in row.pulls ? null : [row.pulls.awaiting, row.pulls.needsYou]))).toEqual([[2, 0], [0, 1], [0, 0], [0, 0], [0, 0]]);
    expect(groupInbox(items, triageReadyRepos(all, states)).awaiting).toBe(2);
    expect(triageReadyRepos(all, states)).toEqual(new Set(["acme/api"]));
    expect(packsPending(states)).toBe(true);
  });

  test("a GitHub failure replaces only the GitHub counts; setup still shows", () => {
    const listing = { repos: [{ repo: "acme/api", prs: [] }, { repo: "acme/web", prs: [], error: "rate limited" }] };
    const [api, web] = repoRows(repos, packs, [], [], [], listing, null);
    expect(api?.pulls).toMatchObject({ open: 0 });
    expect(web).toMatchObject({ href: "/repositories/acme/web", pulls: { error: "rate limited" }, health: { label: "Needs setup" } });
    const failed = repoRows(repos, packs, [], [], [{ name: "acme/api" }], undefined, new Error("offline"));
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
    const all = [...states.keys()].map((name) => repoRecord(name, true));
    const rows = repoRows(all, states, [], [], [], undefined, null);
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
    const items = projectQueue([{ repo: "acme/api", number: 8, source: "github", activityAt: null, verdict, run: null }], [], listing);
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

  test("the same name on both hosts lists both, and each row's link opens its own host's repository", () => {
    const stored = [{ name: "acme/api", connected: true, source: "github" as const, enabled: true }];
    const listed = [{ name: "acme/api", connected: true, source: "bitbucket-datacenter" as const, enabled: false }];
    const merged = mergeRepositories(stored, listed);
    expect(merged).toEqual([stored[0]!, listed[0]!]);
    function opened(href: string) {
      const url = new URL(href, "https://portal.test");
      const [, , owner, repo] = url.pathname.split("/");
      const selection = selectedRepo({ owner, repo }, url.searchParams);
      return selection.redirect ?? findRepo(merged, selection.repo);
    }
    const rows = repoRows(merged, new Map(), [], [], [], undefined, null);
    expect(rows.map((row) => opened(row.href))).toEqual(merged);
    expect(opened("/repositories/acme/api?source=gitlab")).toBe("/repositories");
  });

  test("a link without a host opens the GitHub repository of that name, else the only one with it", () => {
    const github = { name: "acme/api", connected: true, source: "github" as const };
    const bitbucket = { name: "acme/api", connected: true, source: "bitbucket-datacenter" as const };
    const link = selectedRepo({ owner: "acme", repo: "api" }, new URLSearchParams()).repo;
    expect(findRepo([bitbucket, github], link)).toBe(github);
    expect(findRepo([bitbucket], link)).toBe(bitbucket);
    expect(findRepo([bitbucket, { ...bitbucket }], link)).toBeUndefined();
  });

  test("a disabled repository awaits no verdicts while its same-named repository on the other host is on", () => {
    const merged = [
      { name: "acme/api", connected: true, source: "github" as const, enabled: true },
      { name: "acme/api", connected: true, source: "bitbucket-datacenter" as const, enabled: false },
    ];
    const items = projectQueue([], [], twoHosts([1], [2]));
    const [, bitbucket] = repoRows(merged, new Map([["acme/api", policyFile("acme/api")]]), items, [], [], undefined, null);
    expect(bitbucket!.pulls).toMatchObject({ awaiting: 0 });
  });

  test("events and catching up show on the host they happened on, not on the same-named repository on the other host", () => {
    const merged = [
      { name: "acme/api", connected: true, source: "github" as const, enabled: true },
      { name: "acme/api", connected: true, source: "bitbucket-datacenter" as const, enabled: true },
    ];
    const packs = new Map([["acme/api", policyFile("acme/api")]]);
    const active = hostedRepos([{ repo: "acme/api", source: "github" }]);
    const [github, bitbucket] = repoRows(merged, packs, [], active, [{ name: "acme/api", source: "bitbucket-datacenter" }], undefined, null);
    expect([github!.health.label, bitbucket!.health.label]).toEqual(["Webhooks OK", "Catching up"]);
  });
});
