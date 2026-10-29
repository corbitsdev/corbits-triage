import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { PortalSnapshot } from "../../lib/hub-api.ts";
import type { usePortal } from "../../lib/portal.tsx";
import { SessionProvider } from "../../lib/session.tsx";
import { TriageSection } from "./TriageSection.tsx";

let snapshot: PortalSnapshot;
let refreshes = 0;

mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return {
      readOnly: false,
      snapshot,
      refresh() {
        refreshes += 1;
      },
    } as unknown as ReturnType<typeof usePortal>;
  },
}));

const originalFetch = globalThis.fetch;
let root: Root | undefined;

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function show(changes: Partial<PortalSnapshot>) {
  snapshot = {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos: [],
    credentials: [],
    denied: { repos: false, credentials: false, models: false },
    ...changes,
  };
  refreshes = 0;
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
}

test.each([
  ["keys", { credentialsError: "The hub is unavailable." }, "Couldn't read your keys. Triage can't tell whether it is running."],
  ["decision model", { modelsError: "The hub is unavailable." }, "Couldn't read your decision model. Triage can't tell whether it is running."],
])("when the %s cannot be read, the status line says so and offers Try again", (_read, changes, sentence) => {
  show(changes);
  expect(document.body.textContent).toContain(sentence);
  expect(document.body.textContent).not.toContain("no source is connected");
  expect(document.body.textContent).not.toContain("Triage is starting");
  const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  if (!retry) throw new Error("no Try again button");
  act(() => retry.click());
  expect(refreshes).toBe(1);
});

test("when the decision model cannot be read, its card shows the error above the model's row", () => {
  show({ modelsError: "The hub is unavailable." });
  const card = document.querySelector("[aria-labelledby=triage-model]");
  expect(card?.querySelector("[role=alert]")?.textContent).toBe("Triage could not read the saved decision model: The hub is unavailable.");
  expect(card?.textContent).toContain("Judge pull requests with a decision model");
  expect(card?.textContent).toContain("No key");
});
