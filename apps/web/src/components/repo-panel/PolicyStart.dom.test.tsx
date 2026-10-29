import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { usePortal } from "../../lib/portal.tsx";
import PolicyStart from "./PolicyStart.tsx";

const pull = { url: "https://github.com/acme/widgets/pull/7", number: 7, headSha: "head" };
let root: Root | undefined;

mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return { snapshot: { workspace: { tenantId: "tenant" } } } as ReturnType<typeof usePortal>;
  },
}));

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function show(unread: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<QueryClientProvider client={new QueryClient()}><PolicyStart repo="acme/widgets" source="github" pull={pull} unread={unread} disabled={false} /></QueryClientProvider>));
  const row = document.querySelector(".pr-row");
  return { state: row?.querySelector(".state")?.textContent, actions: [...(row?.querySelectorAll("a, button") ?? [])].map((action) => action.textContent) };
}

test("an open policy pull request can be reviewed and merged", () => {
  expect(show(false)).toEqual({ state: "Open, waiting for merge", actions: ["Review on GitHub ", "Merge"] });
});

test("a policy pull request the hub could not check is only linked, with no merge", () => {
  expect(show(true)).toEqual({ state: "Couldn't check the policy pull request.", actions: ["Open on GitHub "] });
});
