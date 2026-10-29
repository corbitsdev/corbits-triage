import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { PortalSnapshot } from "../../lib/hub-api.ts";
import type { usePortal } from "../../lib/portal.tsx";
import { SessionProvider } from "../../lib/session.tsx";
import { TriageSection } from "./TriageSection.tsx";

const snapshot: PortalSnapshot = {
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  workspaces: [],
  invitations: [],
  repos: [],
  credentials: [],
  credentialsError: "The hub is unavailable.",
  denied: { repos: false, credentials: false, models: false },
};

mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return { readOnly: false, snapshot } as unknown as ReturnType<typeof usePortal>;
  },
}));

const originalFetch = globalThis.fetch;
let root: Root | undefined;

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

test("when the keys cannot be read, the status line says so instead of reporting no source", () => {
  globalThis.fetch = function neverAnswers() {
    return new Promise<Response>(() => {});
  } as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <MemoryRouter>
            <TriageSection snapshot={snapshot} deployed={{ rows: [], loading: false, denied: false, unavailable: false, rollouts: [], sidecar: undefined, stalled: undefined }} />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
  });
  expect(document.body.textContent).toContain("Triage could not read its keys, so it cannot tell whether triage is running.");
  expect(document.body.textContent).not.toContain("no source is connected");
});
