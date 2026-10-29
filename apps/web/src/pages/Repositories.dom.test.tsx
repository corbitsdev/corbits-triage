import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { recommendedPack } from "@corbits/triage-contracts";
import type { PortalSnapshot, RepoRecord } from "../lib/hub-api.ts";
import Repositories from "./Repositories.tsx";

const NAME = "acme/api";
const repos: RepoRecord[] = [
  { name: NAME, connected: true, source: "github", enabled: true },
  { name: NAME, connected: true, source: "bitbucket-datacenter", enabled: true },
];
const snapshot: PortalSnapshot = {
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  workspaces: [],
  invitations: [],
  repos,
  credentials: [],
  denied: { repos: false, credentials: false, models: false },
};
const originalFetch = globalThis.fetch;
let root: Root | undefined;

mock.module("../lib/portal.tsx", () => ({
  usePortal() {
    return { snapshot, readOnly: false };
  },
}));

mock.module("../lib/bitbucket-datacenter.ts", () => ({
  useRepositories() { return { repos, pending: false }; },
  useBitbucketDatacenterRepositories() { return { data: undefined, error: null }; },
}));

mock.module("../lib/open-pulls.ts", () => ({
  useOpenPulls() { return { data: undefined, error: null }; },
  useQueueItems() { return []; },
  useQueueLoading() { return false; },
}));

mock.module("../lib/policy-upgrades.ts", () => ({
  usePolicyUpgrades() { return []; },
  upgradeLabel() { return undefined; },
}));

mock.module("../lib/triage-verdicts.ts", () => ({
  useTriageVerdicts() {
    return { data: undefined, pending: false, denied: false, error: null };
  },
}));

mock.module("../lib/github-sync.ts", () => ({
  useGithubSync() { return { error: null, isFetching: false }; },
}));

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

/** The GitHub repository has a policy file; the Bitbucket Data Center one of the same name has none. */
async function policyRead(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "https://hub.test");
  const read = url.searchParams.get("source") === "github"
    ? { status: "ok", pack: recommendedPack(NAME), source: { file: { path: ".corbits-triage.yml", sha: "abc" } }, automatic: [], wanted: [], mergeRisks: [], codeReview: false }
    : { status: "missing" };
  return Response.json(read);
}

async function untilRulesShown() {
  const deadline = Date.now() + 1000;
  while ([...document.querySelectorAll(".c-checks")].some((cell) => cell.textContent === "")) {
    if (Date.now() > deadline) throw new Error("The rules column was still empty after a second.");
    await act(async function flushQueries() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function rowText(source: string): string[] {
  const rows = [...document.querySelectorAll("tbody tr")];
  const row = rows.find((tr) => (tr.querySelector(".src") === null) === (source === "github"));
  return [row?.querySelector(".c-checks")?.textContent ?? "", row?.querySelector(".c-health")?.textContent ?? ""];
}

test("the same repository name on GitHub and Bitbucket Data Center shows each host's own rules and setup", async () => {
  globalThis.fetch = policyRead as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Repositories />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await untilRulesShown();
  const [githubRules, githubHealth] = rowText("github");
  const [bitbucketRules, bitbucketHealth] = rowText("bitbucket-datacenter");
  expect(githubRules).toMatch(/rules? on$/);
  expect(githubHealth).not.toEndWith("Needs setup");
  expect(bitbucketRules).toBe("Not set up");
  expect(bitbucketHealth).toEndWith("Needs setup");
});
