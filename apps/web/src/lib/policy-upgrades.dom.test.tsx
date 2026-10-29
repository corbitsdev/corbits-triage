import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PolicyUpgrades, RepoSource } from "@corbits/triage-contracts";
import { usePolicyFile } from "./policy-file.ts";
import { usePolicyUpgrade } from "./policy-upgrades.ts";
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

/** Answers the upgrades route with each listing in turn, the last one repeating, and counts each host's policy file reads. */
function hub(listings: PolicyUpgrades["repos"][]): Record<RepoSource, number> {
  const reads: Record<RepoSource, number> = { github: 0, "bitbucket-datacenter": 0 };
  let served = 0;
  globalThis.fetch = async function answer(input: string | URL | Request) {
    const url = new URL(String(input), "http://hub.test");
    if (url.pathname.endsWith("/policy/upgrades")) {
      const repos = listings[Math.min(served, listings.length - 1)];
      served += 1;
      return Response.json({ repos });
    }
    const source = url.searchParams.get("source") as RepoSource;
    reads[source] += 1;
    return Response.json({ file: null });
  } as typeof fetch;
  return reads;
}

function Standing({ source }: { source: RepoSource }) {
  usePolicyFile(REPO, source);
  const row = usePolicyUpgrade({ name: REPO, source });
  return <p id={source}>{row ? "Add a policy file" : "Has a policy file"}</p>;
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

test("a repository named the same on both hosts reads its own standing", async () => {
  hub([[
    { repo: REPO, source: "github", upgrade: { state: "start" } },
    { repo: REPO, source: "bitbucket-datacenter", upgrade: { state: "ok" } },
  ]]);
  await mount();
  expect(document.getElementById("github")?.textContent).toBe("Add a policy file");
  expect(document.getElementById("bitbucket-datacenter")?.textContent).toBe("Has a policy file");
});

test("a policy pull request closing reads that repository's policy file again, on its host only", async () => {
  const pull = { url: "https://example.com/pull/7", number: 7 };
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
  expect(reads).toEqual({ github: 1, "bitbucket-datacenter": 1 });
  await settle(() => client.refetchQueries({ queryKey: ["policy-upgrades"] }));
  expect(reads).toEqual({ github: 2, "bitbucket-datacenter": 1 });
});
