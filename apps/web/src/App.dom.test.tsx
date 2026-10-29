import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App.tsx";
import { ApiError, type Transport } from "@intx/hub-client";
import { loadPortal, type PortalSnapshot, type PrItem } from "./lib/hub-api.ts";
import * as checkPacks from "./lib/check-packs.ts";
import * as openPulls from "./lib/open-pulls.ts";
import * as portal from "./lib/portal.tsx";

function Passthrough({ children }: { children: ReactNode }) {
  return children;
}

const connectedSnapshot: PortalSnapshot = {
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  workspaces: [],
  invitations: [],
  repos: [{ name: "acme/widgets", connected: true, source: "github", enabled: true }],
  credentials: [],
  denied: { repos: false, credentials: false, models: false },
};

function item(overrides: Partial<PrItem>): PrItem {
  return {
    key: "acme/widgets#1",
    repo: "acme/widgets",
    number: 1,
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
    href: "/prs/acme/widgets/1",
    source: "github",
    url: null,
    ...overrides,
  };
}

const open = [
  { item: item({ title: "Needs a decision" }), handled: null },
  { item: item({ key: "acme/widgets#2", number: 2, title: "Waiting on the author", state: "needs-author-update", posted: true, comment: "Please rebase" }), handled: null },
];

mock.module("./lib/session.tsx", () => ({
  SessionProvider: Passthrough,
  useSession() {
    return { ready: true, session: { id: "user", email: "ada@acme.dev" }, error: "", async signIn() {}, async signUp() {}, async signOut() {} };
  },
}));

mock.module("./lib/user-cache.tsx", () => ({ UserQueryCache: Passthrough }));

let snapshot = connectedSnapshot;
let connected = true;
let refreshes = 0;
let finishRefresh: () => void = function noRefresh() {};
let failRefresh: (cause: Error) => void = function noRefresh() {};

beforeEach(function connect() {
  snapshot = connectedSnapshot;
  connected = true;
  refreshes = 0;
});

function refreshNow() {
  refreshes += 1;
  return new Promise<PortalSnapshot>((resolve, reject) => {
    finishRefresh = () => resolve(snapshot);
    failRefresh = reject;
  });
}

mock.module("./lib/portal.tsx", () => ({
  ...portal,
  PortalProvider: Passthrough,
  usePortal() {
    return { configured: true, loading: false, connected, readOnly: false, snapshot, invitations: [], unverified: false, loadError: "", warn() {}, notify() {}, refreshNow };
  },
}));

mock.module("./lib/held-inbox.tsx", () => ({
  HeldInboxProvider: Passthrough,
  useSignOutAfterSending() { return async function signOut() {}; },
  useOpenWorkspaceAfterSending() { return async function openWorkspace() {}; },
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

mock.module("./lib/open-pulls.ts", () => ({
  ...openPulls,
  leavesOpen() { return false; },
  useOpenItems() { return open; },
  useMarkedItems() { return { open, known: open }; },
  useOpenPulls() { return { data: undefined, isError: false, isEnabled: false }; },
  useOpenPullsUnanswered() { return false; },
  useQueueLoading() { return false; },
}));

mock.module("./lib/triage-verdicts.ts", () => ({
  useTriageVerdicts() {
    return { data: undefined, pending: false, denied: false, error: null };
  },
}));

mock.module("./lib/check-packs.ts", () => ({
  ...checkPacks,
  useCheckPacks() { return new Map(); },
  useRepoPack() { return null; },
  packOf() { return null; },
}));

mock.module("./lib/tenant-entities.ts", () => ({
  useRoles() {
    return { rows: [], loading: false, denied: false, unavailable: false };
  },
  useAllowed() { return false; },
}));

mock.module("./lib/policy-upgrades.ts", () => ({
  usePolicyUpgrades() { return []; },
  upgradeLabel() { return ""; },
}));

mock.module("./lib/media-query.ts", () => ({
  useMediaQuery() { return false; },
}));

const realFetch = globalThis.fetch;
let root: Root | undefined;

afterEach(function restore() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
});

let requested: string[] = [];

function renderAt(path: string) {
  requested = [];
  globalThis.fetch = async function offline(input: RequestInfo | URL) {
    requested.push(String(input));
    return new Response("", { status: 503 });
  } as unknown as typeof fetch;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`https://portal.test${path}`);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<App />));
}

test("signing in without a decision model lands on Triage, with the Connect prompt above the pull requests that need you", () => {
  renderAt("/");

  expect(document.querySelector("h1")?.textContent).toBe("Triage");
  expect(document.querySelector("#connect-model")?.textContent).toBe("Connect a decision model");
  expect([...document.querySelectorAll("[data-inbox-row]")].map((row) => row.getAttribute("data-inbox-row"))).toEqual(["acme/widgets#1"]);
  expect([...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Waiting"))?.textContent).toBe("Waiting1");
});

test("a pull request open on the old Ready list opens on Triage with the Ready filter", () => {
  renderAt("/ready/acme/widgets/1");

  expect(`${window.location.pathname}${window.location.search}`).toBe("/pr/acme/widgets/1?view=ready");
  expect(document.querySelector("h1")?.textContent).toBe("Triage");
});

test("Triage reads no policy when the workspace has no Triage role to allow actions to", () => {
  renderAt("/");

  expect(document.querySelector("h1")?.textContent).toBe("Triage");
  expect(requested.filter((url) => url.includes("/policy"))).toEqual([]);
});

test("a connected workspace whose keys could not be read sees a notice with Try again, not onboarding", async () => {
  snapshot = { ...connectedSnapshot, credentialsError: "The hub is unavailable." };
  connected = false;
  renderAt("/");

  expect(document.querySelector(".page-notice")?.textContent).toContain("Couldn't read your workspace's keys.");
  expect(document.querySelector("[role=alert]")?.textContent).toBe("The hub is unavailable.");
  expect(document.querySelector("#setup-title")).toBeNull();
  await act(async () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(refreshes).toBe(1);
  const pending = [...document.querySelectorAll("button")].find((button) => button.textContent === "Trying again…");
  expect(pending?.disabled).toBe(true);
  await act(async () => {
    finishRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Try again")).toBe(true);
});

async function retry(unread: PortalSnapshot, settle: () => void) {
  snapshot = unread;
  connected = false;
  renderAt("/");
  await act(async () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a retry that still cannot read the keys says so and offers Try again again", async () => {
  await retry({ ...connectedSnapshot, credentialsError: "The hub is unavailable." }, () => finishRefresh());

  expect([...document.querySelectorAll("[role=alert]")].map((alert) => alert.textContent)).toContain("Still couldn't read your keys.");
  expect([...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")?.disabled).toBe(false);
});

test("a retry that cannot reach the service says so", async () => {
  await retry({ ...connectedSnapshot, credentialsError: "The hub is unavailable." }, () => failRefresh(new Error("Could not reach the service.")));

  expect([...document.querySelectorAll("[role=alert]")].map((alert) => alert.textContent)).toContain("Still couldn't read your keys: Could not reach the service.");
});

async function workspaceUnread(): Promise<PortalSnapshot> {
  async function fetch<T>(method: string, url: string): Promise<T> {
    const path = new URL(url, "http://hub").pathname;
    if (path === "/api/tenants/tenant") throw new ApiError(500, "internal", "The hub is unavailable.");
    if (path === "/api/tenants/tenant/credentials") return { data: [{ id: "crd_github", name: "github", status: "active" }], nextCursor: null } as T;
    if (path.includes("/catalog/")) return { data: [], nextCursor: null } as T;
    if (path.endsWith("/place")) throw new ApiError(403, "forbidden", "forbidden");
    throw new Error(`unexpected ${method} ${path}`);
  }
  const transport = { fetch, subscribe: () => () => {} } as unknown as Transport;
  return loadPortal(transport, { kind: "member", workspace: connectedSnapshot.workspace, workspaces: [{ tenantId: "tenant", name: "Acme", slug: "acme" }], invitations: [] });
}

test("a workspace that could not be read says so with Try again, instead of showing no repositories", async () => {
  snapshot = await workspaceUnread();
  renderAt("/");

  expect(window.location.pathname).toBe("/");
  expect(document.querySelector(".page-notice")?.textContent).toContain("Couldn't read your workspace.");
  expect(document.querySelector("[role=alert]")?.textContent).toBe("The hub is unavailable.");
  expect(document.querySelector(".ws-name")?.textContent).toBe("Acme");
});

test("a retry that still cannot read the workspace says so", async () => {
  await retry(await workspaceUnread(), () => finishRefresh());

  expect(refreshes).toBe(1);
  expect([...document.querySelectorAll("[role=alert]")].map((alert) => alert.textContent)).toContain("Still couldn't read your workspace.");
});

test("a workspace with no keys stored is sent to onboarding", () => {
  snapshot = { ...connectedSnapshot, repos: [] };
  connected = false;
  renderAt("/");

  expect(document.querySelector("#setup-title")?.textContent).toBe("Set up Triage");
});
