import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emptyPack } from "@corbits/triage-contracts";
import { PolicyEditor } from "./PolicyEditor.tsx";

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

test("a switch becomes a change in the tray and the preview shows the file before and after", async () => {
  const pack = emptyPack("acme/widgets");
  pack.checks["ci-green"] = { enabled: true, text: "CI passes.", reason: "Required.", evidence: ["maintainer-stated"] };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <div className="settings">
          <PolicyEditor
            repo="acme/widgets"
            pack={pack}
            reviewOn={false}
            hasModel
            hasPlace
            readOnly={false}
            touched={[]}
            applying={false}
            applyError=""
            preview={async function preview() {
              return { before: "rules: before", after: "rules: after" };
            }}
            onApply={async function apply() {}}
          />
        </div>
      </QueryClientProvider>,
    );
  });
  const focused = [...document.querySelectorAll("[role=switch]")].find((node) => node.getAttribute("aria-label")?.includes("focused"));
  expect(focused).toBeTruthy();
  await act(async () => {
    focused?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(document.body.textContent).toContain("1 change");
  expect(document.body.textContent).toContain("Turn on");
  expect(document.body.textContent).toContain("rules: before");
  expect(document.body.textContent).toContain("rules: after");
});
