import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { starterPack } from "@corbits/triage-contracts";
import PolicySwitches from "./PolicySwitches.tsx";

const REPO = "acme/widgets";
const pack = starterPack(REPO);
let root: Root | undefined;
const originalFetch = globalThis.fetch;

// Other DOM test files replace this module for the whole test process, so this file sets its own.
mock.module("../../lib/portal.tsx", () => ({
  usePortal() {
    return { snapshot: { workspace: { tenantId: "tenant" } } };
  },
}));

afterEach(function unmount() {
  globalThis.fetch = originalFetch;
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Sent = { url: string; body: unknown };

function fakeHub(sent: Sent[]): void {
  globalThis.fetch = async function answer(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    sent.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/policy/patch")) return Response.json({ before: "rules: []\n", after: "rules: [] # off\n" });
    return Response.json({ status: "ok", pack, source: {}, automatic: [], wanted: [], mergeRisks: [], codeReview: false });
  } as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

test("turning a rule off lists the change and previews exactly that change", async () => {
  const sent: Sent[] = [];
  fakeHub(sent);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root?.render(
    <QueryClientProvider client={client}>
      <PolicySwitches
        repo={REPO}
        source="github"
        file={{ path: ".corbits-triage.yml", sha: "sha", url: "https://github.com/acme/widgets" }}
        pack={pack}
        reviewOn={false}
        hasModel
        reviewMissing={undefined}
        pull={null}
        pending={[]}
        disabled={false}
      />
    </QueryClientProvider>,
  ));

  const conflicts = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Flag merge conflicts with the base branch"]');
  if (!conflicts) throw new Error("no switch for the merge conflicts rule");
  act(() => conflicts.click());
  await settle();

  const tray = document.querySelector("aside.tray");
  expect(tray?.querySelector("b")?.textContent).toBe("1 change. Open a pull request to apply it.");
  expect([...(tray?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual(["Turn off “Flag merge conflicts with the base branch”."]);
  const patch = sent.find((request) => request.url.endsWith("/policy/patch"));
  expect(patch?.body).toEqual({ repo: REPO, source: "github", changes: [{ kind: "rule", id: "no-merge-conflicts", enabled: false }], preview: true });
  expect(tray?.textContent).toContain("After it merges, the policy reads:");
});
