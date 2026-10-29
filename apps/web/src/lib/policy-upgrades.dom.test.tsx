import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { PolicyUpgrades, RepoSource } from "@corbits/triage-contracts";
import { checkPackQuery } from "./check-packs.ts";
import { usePolicyFile } from "./policy-file.ts";
import { usePolicyUpgrade, useSettled } from "./policy-upgrades.ts";
import type { usePortal } from "./portal.tsx";

const REPO = "acme/widgets";
let root: Root | undefined;
let client: QueryClient;
const originalFetch = globalThis.fetch;

// Other DOM test files replace this module for the whole test process, so this file sets its own.
mock.module("./portal.tsx", () => ({
  usePortal() {
    return { snapshot: { workspace: { tenantId: "tenant" } } } as ReturnType<typeof usePortal>;
  },
}));

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Reads = Record<"file" | "pack", Record<RepoSource, number>>;

/** Answers the upgrades route with each listing in turn, the last one repeating, and counts each host's policy file and policy reads. */
function hub(listings: PolicyUpgrades["repos"][]): Reads {
  const reads: Reads = { file: { github: 0, "bitbucket-datacenter": 0 }, pack: { github: 0, "bitbucket-datacenter": 0 } };
  let served = 0;
  globalThis.fetch = async function answer(input: string | URL | Request) {
    const url = new URL(String(input), "http://hub.test");
    if (url.pathname.endsWith("/policy/upgrades")) {
      const repos = listings[Math.min(served, listings.length - 1)];
      served += 1;
      return Response.json({ repos });
    }
    const source = url.searchParams.get("source") as RepoSource;
    if (url.pathname.endsWith("/policy/file")) {
      reads.file[source] += 1;
      return Response.json({ file: null });
    }
    reads.pack[source] += 1;
    return Response.json({ status: "missing" });
  } as typeof fetch;
  return reads;
}

function Standing({ source }: { source: RepoSource }) {
  usePolicyFile(REPO, source);
  useQuery(checkPackQuery("tenant", REPO, source));
  const row = usePolicyUpgrade({ name: REPO, source });
  const settled = useSettled({ name: REPO, source });
  return <p id={source}>{row ? "Add a policy file" : "Has a policy file"}{settled ? ", merged just now" : ""}</p>;
}

// Query results reach React on a timer of their own, so each step waits for one.
async function settle(work: () => Promise<unknown> = async () => {}) {
  await act(async () => {
    await work();
    await new Promise((done) => setTimeout(done, 0));
  });
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<QueryClientProvider client={client}><Standing source="github" /><Standing source="bitbucket-datacenter" /></QueryClientProvider>));
  await settle();
}

function relist() {
  return settle(() => client.refetchQueries({ queryKey: ["policy-upgrades"] }));
}

function standing(source: RepoSource) {
  return document.getElementById(source)?.textContent;
}

const pull = { url: "https://example.com/pull/7", number: 7 };

test("a repository named the same on both hosts reads its own standing", async () => {
  hub([[
    { repo: REPO, source: "github", upgrade: { state: "start" } },
    { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "ok" } },
  ]]);
  await mount();
  expect(standing("github")).toBe("Add a policy file");
  expect(standing("bitbucket-datacenter")).toBe("Has a policy file");
});

test("a policy file merged on one host settles that host's repository only and reads its policy again there", async () => {
  const reads = hub([
    [
      { repo: REPO, source: "github", upgrade: { state: "start" }, pull },
      { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "start" } },
    ],
    [
      { repo: REPO, source: "github", upgrade: { state: "ok" } },
      { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "start" } },
    ],
  ]);
  await mount();
  await relist();
  expect(standing("github")).toBe("Has a policy file, merged just now");
  expect(standing("bitbucket-datacenter")).toBe("Add a policy file");
  expect(reads).toEqual({ file: { github: 2, "bitbucket-datacenter": 1 }, pack: { github: 2, "bitbucket-datacenter": 1 } });
});

test("a policy pull request closing reads that repository's policy again, on its host only", async () => {
  const reads = hub([
    [
      { repo: REPO, source: "github", upgrade: { state: "ok" }, pull },
      { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "ok" }, pull },
    ],
    [
      { repo: REPO, source: "github", upgrade: { state: "ok" } },
      { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "ok" }, pull },
    ],
  ]);
  await mount();
  await relist();
  expect(reads).toEqual({ file: { github: 2, "bitbucket-datacenter": 1 }, pack: { github: 2, "bitbucket-datacenter": 1 } });
});

test("a pull request listing the hub could not read keeps the policy pull request open rather than closing it", async () => {
  const reads = hub([
    [{ repo: REPO, source: "github", upgrade: { state: "start" }, pull }],
    [{ repo: REPO, source: "github", upgrade: { state: "start" }, pullUnread: true }],
    [{ repo: REPO, source: "github", upgrade: { state: "start" } }],
  ]);
  await mount();
  await relist();
  expect(reads.file.github).toBe(1);
  expect(client.getQueryState(["policy-upgrades", "tenant"])?.data).toMatchObject({ rows: [{ pull }] });
  await relist();
  expect(reads.file.github).toBe(2);
});
