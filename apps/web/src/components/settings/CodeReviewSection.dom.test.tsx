import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CodeReviewPlaceOption } from "@corbits/triage-contracts";
import { CodeReviewPlaceNotice } from "./CodeReviewSection.tsx";

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const PLACES: CodeReviewPlaceOption[] = [
  { id: "docker-remote", label: "Docker on another machine (TLS)", why: "", env: ["DOCKER_HOST=tcp://docker.example.com:2376"], guide: "https://example.com/docker-remote.md", state: "not_set_up" },
  { id: "e2b", label: "E2B sandboxes", why: "", env: ["E2B_API_KEY=e2b_your_key"], guide: "https://example.com/e2b.md", state: "not_set_up" },
];

function show(place: string | null | undefined) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient();
  act(() => root?.render(<QueryClientProvider client={client}><CodeReviewPlaceNotice place={place} places={PLACES} /></QueryClientProvider>));
  return host;
}

test("the code review notice shows the first place's setup only while no place is in use", () => {
  const missing = show(null);
  const notice = missing.querySelector("[role=status]");
  expect(notice?.textContent).toContain("Code review needs an isolated place to run.");
  expect(notice?.querySelector("pre")?.textContent).toBe("DOCKER_HOST=tcp://docker.example.com:2376");
  expect(notice?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docker-remote.md");

  act(() => root?.unmount());
  document.body.innerHTML = "";
  const active = show("docker");
  expect(active.querySelector("[role=status]")).toBeNull();
  expect(active.textContent).toBe("");
});
