import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RepoSource } from "@corbits/triage-contracts";
import { PolicyFiles } from "../components/settings/PolicyFiles.tsx";
import type { PortalSnapshot, PrItem, RepoRecord } from "../lib/hub-api.ts";
import * as policyUpgrades from "../lib/policy-upgrades.ts";
import type { PolicyUpgradeRow } from "../lib/policy-upgrades.ts";
import { findRepo, selectedRepo } from "../lib/repo-rows.ts";
import Inbox from "./Inbox.tsx";
import Repositories from "./Repositories.tsx";

const NAME = "acme/api";

const github = { name: NAME, connected: true, source: "github" as const, enabled: true };
const bitbucket = { name: NAME, connected: true, source: "bitbucket-datacenter" as const, enabled: true };
const repos = [github, bitbucket];

let open: Array<{ item: PrItem; handled: null }> = [];
let upgrades: PolicyUpgradeRow[] = [];

mock.module("../lib/portal.tsx", () => ({
  usePortal() {
    return {
      snapshot: portalSnapshot(),
      readOnly: false,
      async triagePullRequest() {},
    };
  },
}));

mock.module("../lib/held-inbox.tsx", () => ({
  useHeldInbox() {
    return {
      notices: { held: null, outcome: null },
      restored: {},
      hold() {},
      undo() { return false; },
      forgetRestored() {},
      enter() { return () => {}; },
      flush() { return Promise.resolve(); },
    };
  },
}));

mock.module("../lib/open-pulls.ts", () => ({
  leavesOpen() { return false; },
  useOpenItems() { return open; },
  useQueueItems() { return open.map((entry) => entry.item); },
  useMarkedItems() { return { open, known: open }; },
  useOpenPulls() { return { data: undefined, isError: false, isEnabled: false }; },
  useOpenPullsUnanswered() { return false; },
  useQueueLoading() { return false; },
}));

mock.module("../lib/tenant-entities.ts", () => ({
  useRoles() {
    return { rows: [], loading: true, denied: false, unavailable: false };
  },
  useAllowed() { return false; },
}));

mock.module("../lib/triage-verdicts.ts", () => ({
  useTriageVerdicts() {
    return { data: undefined, pending: false, denied: false, error: null };
  },
}));

mock.module("../lib/check-packs.ts", () => ({
  useCheckPacks() { return new Map(); },
  useRepoPack() { return null; },
  packOf() { return null; },
}));

mock.module("../lib/github-pull.ts", () => ({
  useGithubPull() {
    return { data: undefined, isLoading: false, error: null };
  },
}));

mock.module("../lib/bitbucket-datacenter.ts", () => ({
  useRepositories() { return { repos, pending: false }; },
  useBitbucketDatacenterRepositories() { return { error: null }; },
}));

mock.module("../lib/github-sync.ts", () => ({
  useGithubSync() { return { error: null, isFetching: false }; },
}));

mock.module("../lib/media-query.ts", () => ({
  useMediaQuery() { return true; },
}));

mock.module("../lib/policy-file.ts", () => ({
  usePolicyFile() {
    return { data: null, isError: false };
  },
}));

const realPolicyUpgrades = { ...policyUpgrades };

mock.module("../lib/policy-upgrades.ts", () => ({
  ...realPolicyUpgrades,
  usePolicyUpgrade() {
    return { repo: NAME, source: "github" satisfies RepoSource, upgrade: { state: "start" } };
  },
  usePolicyUpgrades() {
    return upgrades;
  },
}));

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function portalSnapshot(): PortalSnapshot {
  return {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos,
    credentials: [],
    denied: { repos: false, credentials: false, models: false },
  };
}

function pull(source: RepoSource, number: number): PrItem {
  return {
    key: `${NAME}#${source}`,
    repo: NAME,
    number,
    title: "Fix",
    author: "ada",
    authorKind: null,
    byTriage: false,
    draft: false,
    mergeable: null,
    mergeBlock: null,
    state: "needs-decision",
    priority: "P2",
    owner: null,
    nextAction: null,
    verdict: "unsure",
    score: 0.5,
    reasons: [],
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    verdictSha: null,
    degraded: null,
    needsHuman: false,
    closed: false,
    pendingApprovalId: null,
    runId: "run-1",
    waitingSince: "2026-10-01T00:00:00.000Z",
    updatedAt: null,
    ci: null,
    headSha: null,
    activityAt: null,
    reviewAnswered: false,
    posted: false,
    running: false,
    waitingForCi: false,
    waitingHeadSha: null,
    awaiting: [],
    failure: null,
    actions: [],
    automatic: [],
    href: `/prs/${NAME}/${number}`,
    source,
    url: null,
  };
}

function waitingOnBoth(): PolicyUpgradeRow[] {
  return [
    { repo: NAME, source: "github", upgrade: { state: "start" }, pull: { url: "https://github.com/pull/1", number: 1 } },
    { repo: NAME, source: "bitbucket-datacenter", upgrade: { state: "start" }, pull: { url: "https://bitbucket.example/pull/1", number: 1 } },
  ];
}

function show(first: RepoSource) {
  upgrades = waitingOnBoth();
  const order = first === "github" ? ["github", "bitbucket-datacenter"] as const : ["bitbucket-datacenter", "github"] as const;
  open = order.map((source, index) => ({ item: pull(source, index + 1), handled: null }));
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Inbox />
          <PolicyFiles snapshot={portalSnapshot()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** The repository a link names, resolved the way the repository page does. */
function opened(href: string): RepoRecord | undefined {
  const url = new URL(href, "https://portal.test");
  const [, , owner, repo] = url.pathname.split("/");
  const selection = selectedRepo({ owner, repo }, url.searchParams);
  if (selection.redirect !== null || selection.repo === null) return undefined;
  return findRepo(repos, selection.repo);
}

function hrefs(selector: string): string[] {
  return [...document.querySelectorAll<HTMLAnchorElement>(selector)].map((link) => link.getAttribute("href") ?? "");
}

test("the same repository name on GitHub and Bitbucket Data Center opens each host from the inbox and the policy files list", () => {
  show("github");
  const pane = document.querySelector("a.repo-link")?.getAttribute("href") ?? "";
  const waiting = hrefs(".note a[href^='/repositories/']");
  const starting = [...document.querySelectorAll("a.linkish")].filter((link) => link.textContent === "Start a policy file").map((link) => link.getAttribute("href") ?? "");
  expect(opened(pane)?.source).toBe("github");
  expect(waiting.map((href) => opened(href)?.source)).toEqual(["github", "bitbucket-datacenter"]);
  expect(starting.map((href) => opened(href)?.source)).toEqual(["github", "bitbucket-datacenter"]);

  act(() => root?.unmount());
  document.body.innerHTML = "";
  show("bitbucket-datacenter");
  expect(opened(document.querySelector("a.repo-link")?.getAttribute("href") ?? "")?.source).toBe("bitbucket-datacenter");
});

/** Each row of the repositories list as its host and its health mark. */
function repositoriesHealth(): Array<[RepoSource, string | null | undefined]> {
  open = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/repositories"]}>
          <Routes><Route path="/repositories" element={<Repositories />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return [...document.querySelectorAll("tbody tr")].map((row) => [row.querySelector(".c-name small.src") ? "bitbucket-datacenter" : "github", row.querySelector(".c-health .hl")?.textContent]);
}

test("the repositories list gives each host's repository of the same name its own policy standing", () => {
  upgrades = [
    { repo: NAME, source: "github", upgrade: { state: "start" }, pull: { url: "https://github.com/pull/1", number: 1 } },
    { repo: NAME, source: "bitbucket-datacenter", upgrade: { state: "start" } },
  ];
  expect(repositoriesHealth()).toEqual([["github", "Waiting for merge"], ["bitbucket-datacenter", "!Add a policy file"]]);
});

test("a policy pull request the hub could not check is not shown as waiting for merge", () => {
  upgrades = [
    { repo: NAME, source: "github", upgrade: { state: "start" }, pull: { url: "https://github.com/pull/1", number: 1 }, pullUnread: true },
    { repo: NAME, source: "bitbucket-datacenter", upgrade: { state: "start" }, pull: { url: "https://bitbucket.example/pull/1", number: 1 } },
  ];
  expect(repositoriesHealth()).toEqual([["github", "!Couldn't check the policy pull request."], ["bitbucket-datacenter", "Waiting for merge"]]);
});
