import { afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { recommendedPack, starterPack, type CheckPack } from "@corbits/triage-contracts";
import { HeldInboxProvider } from "../../lib/held-inbox.tsx";
import { policyNeedsModel } from "../../lib/pack-rules.ts";
import { BITBUCKET_DATACENTER_CREDENTIAL_NAME, GITHUB_CREDENTIAL_NAME, type HubCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import type { usePortal } from "../../lib/portal.tsx";
import { SessionProvider } from "../../lib/session.tsx";
import Connect from "../../pages/Connect.tsx";
import TriageSwitch from "./TriageSwitch.tsx";

const REPO = "acme/widgets";
let root: Root | undefined;
let portal: ReturnType<typeof usePortal>;
const originalFetch = globalThis.fetch;

// Other DOM test files replace this module for the whole test process, so this file sets its own.
mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return portal;
  },
}));

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function credential(): HubCredential {
  return {
    id: "credential",
    tenantId: "tenant",
    name: GITHUB_CREDENTIAL_NAME,
    type: "other",
    status: "active",
    providerId: "provider",
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
  };
}

function snapshot(pack: CheckPack, model: PortalSnapshot["decisionModel"]): PortalSnapshot {
  return {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos: [{ name: pack.repo, connected: true, source: "github", enabled: true }],
    credentials: [credential()],
    ...(model ? { decisionModel: model } : {}),
    denied: { repos: false, credentials: false, models: false },
  };
}

function portalValue(current: PortalSnapshot): ReturnType<typeof usePortal> {
  return {
    configured: true,
    loading: false,
    readOnly: false,
    connected: true,
    snapshot: current,
    invitations: [],
    unverified: false,
    loadError: "",
    notify() {},
    warn() {},
    refresh() {},
    refreshNow: async () => current,
    openWorkspace() {},
    syncFromGithub: async () => ({ repos: current.repos.map((repo) => repo.name) }),
    configureHook: async () => "",
    removeRepo: async () => {},
    runBacklog: async () => {},
    triagePullRequest: async () => {},
    writeGithub: async () => ({ commentId: null }),
    decide: async () => {},
    replaceSecret: async () => {},
    revoke: async () => {},
    saveInferenceSecret: async () => {},
    saveAnthropic: async () => {},
    removeAnthropic: async () => {},
    removeDecisionModel: async () => {},
  };
}

/** The Bitbucket Data Center repositories the hub lists, `"fails"` for a failed listing, or null for no connection. */
type BitbucketListing = Array<{ name: string; connected: boolean; source: "bitbucket-datacenter" }> | "fails" | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `accessAnswered` false leaves the access check loading. */
function hubFetch(bitbucket: BitbucketListing, accessAnswered: boolean): void {
  globalThis.fetch = async function answer(input: RequestInfo | URL) {
    const path = new URL(input instanceof Request ? input.url : String(input), "http://hub.test").pathname;
    if (path.endsWith("/evaluate")) return accessAnswered ? json({ effect: "allow" }) : new Promise<Response>(() => {});
    if (path.endsWith("/bitbucket-datacenter/tenant/connection")) {
      return bitbucket === null ? json({ error: "not found" }, 404) : json({ baseUrl: "https://bitbucket.test", hookUrl: "https://hub.test/hook" });
    }
    if (path.endsWith("/bitbucket-datacenter/tenant/repositories")) {
      return bitbucket === "fails" ? json({ error: "unavailable" }, 500) : json({ repositories: bitbucket });
    }
    return new Response("", { status: 401 });
  } as unknown as typeof fetch;
}

/** Waits until only `stillFetching` queries are fetching across two flushes, so a query a finished one enables has started and settled too; more after a second fails the test. */
async function settle(client: QueryClient, stillFetching: number) {
  const deadline = Date.now() + 1000;
  let idleFlushes = 0;
  while (idleFlushes < 2) {
    if (Date.now() > deadline) throw new Error("Queries were still fetching after a second.");
    await act(async function flushQueries() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    idleFlushes = client.isFetching() === stillFetching ? idleFlushes + 1 : 0;
  }
}

async function mount(node: ReactNode, bitbucket: BitbucketListing = null, accessAnswered = true) {
  hubFetch(bitbucket, accessAnswered);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async function renderAndSettle() {
    root?.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await Promise.resolve();
  });
  await settle(client, accessAnswered ? 0 : 1);
}

function mountSwitch(changes: Partial<PortalSnapshot>) {
  const pack = recommendedPack(REPO);
  portal = portalValue({ ...snapshot(pack, undefined), ...changes });
  return mount(
    <MemoryRouter>
      <TriageSwitch
        repo={pack.repo}
        enabled={false}
        triaging={false}
        disabled={false}
        onSwitch={() => {}}
        ruleOn
        needsModel={policyNeedsModel(pack)}
        rerunnable
      />
    </MemoryRouter>,
  );
}

function Where() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

test("a judgement policy with no saved model says it needs a model", async () => {
  await mountSwitch({});
  expect(document.body.textContent).toContain("needs a model");
  expect(document.querySelector("a")?.getAttribute("href")).toBe("/settings/triage");
});

test("the same policy with a saved model shows no model prompt", async () => {
  await mountSwitch({ decisionModel: { endpoint: "https://example.com", model: "jev" } });
  expect(document.body.textContent ?? "").not.toContain("needs a model");
});

test.each([
  ["model catalog", { modelsError: "The hub is unavailable." }],
  ["key", { credentialsError: "The hub is unavailable." }],
])("a failed %s read shows no model prompt", async (_read, changes) => {
  await mountSwitch(changes);
  expect(document.body.textContent ?? "").not.toContain("needs a model");
});

function mountConnect(current: PortalSnapshot, bitbucket: BitbucketListing = null, accessAnswered = true) {
  portal = portalValue(current);
  return mount(
    <SessionProvider>
      <MemoryRouter initialEntries={["/connect"]}>
        <HeldInboxProvider>
          <Routes>
            <Route path="/connect" element={<Connect />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </HeldInboxProvider>
      </MemoryRouter>
    </SessionProvider>,
    bitbucket,
    accessAnswered,
  );
}

function bitbucketOnly(): PortalSnapshot {
  return { ...snapshot(starterPack(REPO), undefined), repos: [], credentials: [{ ...credential(), name: BITBUCKET_DATACENTER_CREDENTIAL_NAME }] };
}

function openRepositoriesButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((element) => element.textContent === "Open Repositories");
}

test("setup has no decision model step and opens Repositories", async () => {
  await mountConnect(snapshot(starterPack(REPO), undefined));
  expect(document.body.textContent).not.toContain("Decision model");
  expect(document.body.textContent).toContain("Two steps");
  const button = openRepositoriesButton();
  if (!button) throw new Error("no Open Repositories button");
  act(() => button.click());
  expect(document.body.textContent).toContain("/repositories");
});

test("setup opens Repositories once Bitbucket Data Center lists a repository", async () => {
  await mountConnect(bitbucketOnly(), [{ name: "PROJ/widgets", connected: false, source: "bitbucket-datacenter" }]);
  expect(openRepositoriesButton()).toBeDefined();
});

test("setup with no repositories visible says so and links to the connection", async () => {
  await mountConnect(bitbucketOnly(), []);
  expect(document.querySelector("[aria-current=step] h2")?.textContent).toBe("Repositories");
  expect(openRepositoriesButton()).toBeUndefined();
  expect(document.body.textContent).toContain("No repositories are visible to this connection yet.");
  expect(document.querySelector("[aria-current=step] a")?.getAttribute("href")).toBe("/settings/triage");
});

test("setup shows a failed Bitbucket Data Center listing with Try again", async () => {
  await mountConnect(bitbucketOnly(), "fails");
  expect(openRepositoriesButton()).toBeUndefined();
  expect(document.querySelector("[role=alert]")?.textContent).toContain("Could not read your repositories from Bitbucket Data Center.");
  expect([...document.querySelectorAll("button")].some((element) => element.textContent === "Try again")).toBe(true);
});

test("setup back from GitHub says nothing about visible repositories while access is still loading", async () => {
  const browser = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;
  browser.setURL("https://portal.test/connect?installation_id=1");
  try {
    await mountConnect({ ...snapshot(starterPack(REPO), undefined), repos: [] }, null, false);
    expect(document.body.textContent).toContain("Choose repositories again");
    expect(document.body.textContent).not.toContain("No repositories are visible");
  } finally {
    browser.setURL("https://portal.test/");
  }
});
