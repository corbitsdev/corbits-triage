import { afterEach, expect, test } from "bun:test";
import { act, useState, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { KeyPopup } from "./KeyPopup.tsx";
import type { KeyFormProps } from "./settings/AnthropicKeyForm.tsx";

const SAVE = ["test-key"];
let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Harness = { saved: number; cancelled: number; finishSave: () => void };

function mount(): Harness {
  const harness: Harness = { saved: 0, cancelled: 0, finishSave: () => {} };

  function slowSave() {
    return new Promise<void>(function hold(done) {
      harness.finishSave = done;
    });
  }

  function SlowForm({ submitLabel, onCancel, onSaved }: KeyFormProps) {
    const run = useMutation({ mutationKey: SAVE, mutationFn: slowSave });
    function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      run.mutate(undefined, { onSuccess: onSaved });
    }
    return (
      <form onSubmit={submit}>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button type="submit">{submitLabel}</button>
      </form>
    );
  }

  function Opener() {
    const [open, setOpen] = useState(true);
    function cancel() {
      harness.cancelled += 1;
      setOpen(false);
    }
    function saved() {
      harness.saved += 1;
      setOpen(false);
    }
    function focusOpener() {
      document.getElementById("opener")?.focus();
    }
    return (
      <>
        <button id="opener" type="button">Switch</button>
        <button type="button" onClick={() => setOpen(false)}>Key stored</button>
        <KeyPopup open={open} title="Needs a key" description="Paste it." mutationKey={SAVE} onCancel={cancel} returnFocus={focusOpener}>
          <SlowForm layout="popup" submitLabel="Save and turn on" onCancel={cancel} onSaved={saved} />
        </KeyPopup>
      </>
    );
  }

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<QueryClientProvider client={new QueryClient()}><Opener /></QueryClientProvider>));
  return harness;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

function dialogOpen(): boolean {
  return document.querySelector("[role=dialog]") !== null;
}

// Query and focus updates land on the next task, as they do in the browser.
async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 0)));
}

function pressEscape() {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

test("while the key saves, Escape and the close button leave the popup open, and the save then finishes", async () => {
  const harness = mount();
  act(() => button("Save and turn on").click());
  await settle();

  pressEscape();
  act(() => button("Close").click());
  expect(dialogOpen()).toBe(true);
  expect(harness.cancelled).toBe(0);

  await act(async () => harness.finishSave());
  expect(harness.saved).toBe(1);
  expect(dialogOpen()).toBe(false);
});

test("a key showing up as stored while it saves keeps the popup open until the save calls onSaved", async () => {
  const harness = mount();
  act(() => button("Save and turn on").click());
  await settle();

  act(() => button("Key stored").click());
  expect(dialogOpen()).toBe(true);

  await act(async () => harness.finishSave());
  await settle();
  expect(harness.saved).toBe(1);
  expect(dialogOpen()).toBe(false);
});

test("Escape before saving cancels and puts focus back on the control that opened it", async () => {
  const harness = mount();
  pressEscape();
  await settle();
  expect(harness.cancelled).toBe(1);
  expect(dialogOpen()).toBe(false);
  expect(document.activeElement?.id).toBe("opener");
});
