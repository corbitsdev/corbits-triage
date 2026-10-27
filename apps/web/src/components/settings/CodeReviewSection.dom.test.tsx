import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PortalSnapshot } from "../../lib/hub-api.ts";
import { CodeReviewSection } from "./CodeReviewSection.tsx";

mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return { readOnly: false, async removeAnthropic() {} };
  },
}));

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function snapshot(): PortalSnapshot {
  return {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos: [],
    credentials: [],
    credentialsError: "The hub is unavailable.",
    denied: { repos: false, credentials: false, models: false },
  };
}

test("when the saved keys cannot be read, the row says so and offers no key field", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <CodeReviewSection snapshot={snapshot()} />
      </QueryClientProvider>,
    );
  });
  expect(document.body.textContent).toContain("Triage could not read the saved keys: The hub is unavailable.");
  expect(document.body.textContent).not.toContain("No key");
  expect(document.querySelector("input[type=password]")).toBeNull();
});
