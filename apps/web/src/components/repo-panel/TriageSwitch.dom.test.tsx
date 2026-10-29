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

function snapshot(pack: CheckPack, model: PortalSnapshot["decisionModel"], modelsDenied = false): PortalSnapshot {
  return {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos: [{ name: pack.repo, connected: true, source: "github", enabled: true }],
    credentials: [credential()],
    ...(model ? { decisionModel: model } : {}),
    denied: { repos: false, credentials: false, models: modelsDenied },
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

function quietFetch(): void {
  globalThis.fetch = async function failClosed() {
    return new Response("", { status: 401 });
  } as unknown as typeof fetch;
}

async function mount(node: ReactNode) {
  quietFetch();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async function renderAndSettle() {
    root?.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await Promise.resolve();
  });
}

function mountSwitch(pack: CheckPack, model: PortalSnapshot["decisionModel"], modelsDenied = false) {
  portal = portalValue(snapshot(pack, model, modelsDenied));
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
  await mountSwitch(recommendedPack(REPO), undefined);
  expect(document.body.textContent).toContain("needs a model");
  expect(document.querySelector("a")?.getAttribute("href")).toBe("/settings/triage");
});

test("the same policy with a saved model shows no model prompt", async () => {
  await mountSwitch(recommendedPack(REPO), { endpoint: "https://example.com", model: "jev" });
  expect(document.body.textContent ?? "").not.toContain("needs a model");
});

test("a refused model catalog read shows no model prompt", async () => {
  await mountSwitch(recommendedPack(REPO), undefined, true);
  expect(document.body.textContent ?? "").not.toContain("needs a model");
});

function mountConnect(current: PortalSnapshot) {
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
  );
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

test("setup offers no Open Repositories while there are no repositories to open", async () => {
  await mountConnect({ ...snapshot(starterPack(REPO), undefined), repos: [], credentials: [{ ...credential(), name: BITBUCKET_DATACENTER_CREDENTIAL_NAME }] });
  expect(document.querySelector("[aria-current=step] h2")?.textContent).toBe("Repositories");
  expect(document.body.textContent).not.toContain("Choose repositories on GitHub");
  expect(openRepositoriesButton()).toBeUndefined();
});
