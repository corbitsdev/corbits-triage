import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { UPGRADE_STEP_LABEL, useUpgradeRun, type UpgradeStep } from "./triage-upgrade.ts";

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${name} button`);
  return found;
}

async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 0)));
}

function ignored() {}

test("a second button cannot start a second upgrade", async () => {
  const runs = { count: 0 };
  function run(onStep: (step: UpgradeStep) => void): Promise<RepoSource[]> {
    runs.count += 1;
    onStep("publishing");
    onStep("starting");
    return new Promise(function hang() {});
  }

  function UpgradeButton({ label }: { label: string }) {
    const upgrade = useUpgradeRun(run, ignored, ignored);
    const text = upgrade.step === undefined ? label : UPGRADE_STEP_LABEL[upgrade.step];
    return <button type="button" aria-label={label} disabled={upgrade.running} onClick={upgrade.start}>{text}</button>;
  }

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <UpgradeButton label="Upgrade one" />
        <UpgradeButton label="Upgrade two" />
      </QueryClientProvider>,
    );
  });

  act(() => {
    button("Upgrade one").click();
    button("Upgrade two").click();
  });
  await settle();

  expect(runs.count).toBe(1);
  expect(button("Upgrade one").disabled).toBe(true);
  expect(button("Upgrade two").disabled).toBe(true);
  expect(button("Upgrade one").textContent).toBe(UPGRADE_STEP_LABEL.starting);
  expect(button("Upgrade two").textContent).toBe(UPGRADE_STEP_LABEL.starting);

  act(() => {
    button("Upgrade two").click();
  });
  await settle();
  expect(runs.count).toBe(1);
});
