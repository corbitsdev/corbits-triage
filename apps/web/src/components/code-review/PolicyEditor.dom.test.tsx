import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emptyPack, type PolicyPatchChange } from "@corbits/triage-contracts";
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

function switchNamed(label: string): HTMLElement {
  const found = [...document.querySelectorAll("[role=switch]")].find((node) => node.getAttribute("aria-label") === label);
  if (!(found instanceof HTMLElement)) throw new Error(label);
  return found;
}

function setField(label: string, value: string) {
  const input = document.querySelector(`[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("a new size rule and forbidden paths wait for a value, then the batch enables the rule and sets the option", async () => {
  const pack = emptyPack("acme/widgets");
  const seen: PolicyPatchChange[][] = [];
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
            preview={async function preview(changes) {
              seen.push(changes.map((change) => change));
              return { before: "before", after: "after" };
            }}
            onApply={async function apply() {}}
          />
        </div>
      </QueryClientProvider>,
    );
  });

  await act(async () => {
    switchNamed("Flag pull requests over any number of lines changed").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(seen).toEqual([]);
  expect(document.body.textContent).not.toContain("Open a pull request");
  expect(document.body.textContent).toContain("How many lines?");

  await act(async () => {
    setField("How many lines?", "400");
  });
  await act(async () => {
    const use = [...document.querySelectorAll("button")].find((node) => node.textContent === "Use this");
    if (!(use instanceof HTMLButtonElement)) throw new Error("Use this");
    use.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const lines = [
    { kind: "rule", id: "max-lines-changed", enabled: true },
    { kind: "rule-options", id: "max-lines-changed", options: { max: 400 } },
  ];
  expect(seen).toEqual([lines]);

  await act(async () => {
    switchNamed("Never accept changes to forbidden paths").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(seen).toEqual([lines]);
  expect(document.body.textContent).toContain("Which paths?");

  await act(async () => {
    setField("Which paths?", "vendor/**, secrets/**");
  });
  await act(async () => {
    const use = [...document.querySelectorAll("button")].find((node) => node.textContent === "Use this");
    if (!(use instanceof HTMLButtonElement)) throw new Error("Use this");
    use.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(seen[1]).toEqual([
    ...lines,
    { kind: "rule", id: "no-forbidden-paths", enabled: true },
    { kind: "rule-options", id: "no-forbidden-paths", options: { paths: ["vendor/**", "secrets/**"] } },
  ]);
});

test("a size rule already in the file toggles with only enabled", async () => {
  const pack = emptyPack("acme/widgets");
  pack.checks["max-lines-changed"] = { enabled: false, maxLines: 400 };
  const seen: PolicyPatchChange[][] = [];
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
            preview={async function preview(changes) {
              seen.push(changes.map((change) => change));
              return { before: "before", after: "after" };
            }}
            onApply={async function apply() {}}
          />
        </div>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    switchNamed("Flag pull requests over 400 lines changed").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(document.body.textContent).not.toContain("How many lines?");
  expect(seen).toEqual([[{ kind: "rule", id: "max-lines-changed", enabled: true }]]);
});
