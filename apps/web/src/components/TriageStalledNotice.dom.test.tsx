import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TriageStalledNotice } from "./TriageStalledNotice.tsx";

let root: Root | undefined;

afterEach(function restore() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

test("the workspace is told which host has pull requests waiting for Triage only while the hub counts it stalled", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<MemoryRouter><TriageStalledNotice stalled={undefined} /></MemoryRouter>));
  const status = document.querySelector("[role=status]");
  expect(status?.textContent).toBe("");

  const since = new Date("2026-10-27T10:42:00Z");
  act(() => root?.render(<MemoryRouter><TriageStalledNotice stalled={[{ source: "bitbucket-datacenter", since: since.toISOString() }]} /></MemoryRouter>));
  expect(document.querySelector("[role=status]")).toBe(status);
  expect(status?.textContent).toContain(`Pull requests on Bitbucket Data Center have waited since ${since.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} for Triage to start.`);
  expect(document.querySelector("a")?.getAttribute("href")).toBe("/settings/triage");
});
