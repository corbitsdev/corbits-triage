import { beforeEach, expect, spyOn, test } from "bun:test";
import { fakeBrowser } from "./fake-browser.ts";
import { sessionLogin } from "./session-reads.ts";
import { readAs, saveView, viewer, views } from "./storage.ts";
import type { TriageView } from "./view.ts";

const VIEW: TriageView = { pr: { repo: "o/r", number: 1 }, headSha: "a", ranAt: "2026-10-23T00:00:00Z", policy: { path: ".corbits-triage.yml", url: "" }, checks: [], notes: [], codeReview: { review: null } };

async function savedAs(login: string): Promise<void> {
  fakeBrowser.reset();
  await readAs(login);
  await saveView(VIEW, login);
}

beforeEach(async () => {
  await savedAs("a");
});

test("checks read as one account are cleared when another signs in", async () => {
  expect(await readAs("b")).toBe(false);
  expect(await views.getValue()).toEqual({});
  expect(await viewer.getValue()).toBe("b");
});

test("checks are kept while the same account stays signed in", async () => {
  expect(await readAs("a")).toBe(true);
  expect(Object.keys(await views.getValue())).toHaveLength(1);
});

test("checks are kept while no one stays signed in", async () => {
  await savedAs("");
  expect(await readAs("")).toBe(true);
  expect(Object.keys(await views.getValue())).toHaveLength(1);
});

test("a run started as one account and finished after another signed in is not saved", async () => {
  await readAs("b");
  await saveView(VIEW, "a");
  expect(await views.getValue()).toEqual({});
});

test("a github.com page that does not say who is signed in fails the run, so nothing is reused", async () => {
  const fetched = spyOn(globalThis, "fetch").mockResolvedValue(new Response('<meta name="user-login" content="">'));
  try {
    await expect(sessionLogin()).rejects.toThrow("github.com did not say who is signed in.");
  } finally {
    fetched.mockRestore();
  }
});

test("the signed-in login is read whatever order the meta tag's attributes are in", async () => {
  const fetched = spyOn(globalThis, "fetch").mockResolvedValue(new Response('<meta content="a" name="user-login">'));
  try {
    expect(await sessionLogin()).toBe("a");
  } finally {
    fetched.mockRestore();
  }
});
