import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HubCredential, PortalSnapshot } from "../../lib/hub-api.ts";

mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return {
      readOnly: false,
      async removeAnthropic() {},
      async saveAnthropic() {},
    };
  },
}));

const { CodeReviewSection } = await import("./CodeReviewSection.tsx");

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const stored: HubCredential = {
  id: "crd_anthropic",
  tenantId: "tenant",
  providerId: "prv_anthropic",
  name: "anthropic",
  type: "api_key",
  status: "active",
  createdAt: "2026-03-10T00:00:00.000Z",
  updatedAt: "2026-03-10T00:00:00.000Z",
};

function snapshot(credentials: HubCredential[]): PortalSnapshot {
  return {
    workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
    tenantName: "Acme",
    workspaces: [],
    invitations: [],
    repos: [],
    credentials,
    denied: { repos: false, credentials: false, models: false },
  };
}

function mount(credentials: HubCredential[]) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <CodeReviewSection snapshot={snapshot(credentials)} />
      </QueryClientProvider>,
    );
  });
}

function password(): HTMLInputElement | null {
  return document.querySelector("input[type=password]");
}

test("a stored key is present, and the field stays hidden until rotate", () => {
  mount([stored]);
  expect(document.body.textContent).toContain("Key stored");
  expect(document.body.textContent).not.toContain("No key");
  expect(password()).toBeNull();
  const rotate = [...document.querySelectorAll("button")].find((button) => button.textContent === "Rotate");
  if (!rotate) throw new Error("no Rotate button");
  act(() => rotate.click());
  const field = password();
  expect(field).not.toBeNull();
  expect(field?.value).toBe("");
});

test("the key field is open only when no key is stored", () => {
  mount([]);
  expect(document.body.textContent).toContain("No key");
  expect(password()?.value).toBe("");
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Rotate")).toBe(false);
});
