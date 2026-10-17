import { expect, test } from "bun:test";
import type { WorkflowAuthorizeFn } from "@intx/workflow";
import { runLocalWorkflow } from "../evals/run-local.js";
import * as actions from "./actions/index.js";
import { credentialBindings } from "./agents.js";
import { triageDirector } from "./directors.js";
import type { Measured } from "./logic/history.js";
import { workflow } from "./repo-scan.js";

const REPO = "acme/widgets";

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

function pull(number: number, merged: boolean) {
  return { number, merged_at: merged ? "2026-10-01T00:00:00Z" : null, closed_at: "2026-10-01T00:00:00Z" };
}

/** Two pages of closed pull requests: a full first page, then a merged #1 that a limit of 100 leaves unread. */
const PAGES: Record<string, unknown[]> = {
  "1": [pull(3, true), pull(2, false), ...Array.from({ length: 98 }, (_, i) => pull(100 + i, true))],
  "2": [pull(1, true)],
};

const FILES: Record<number, unknown[]> = {
  3: [{ filename: "README.md", status: "modified", additions: 2, deletions: 1 }],
  2: Array.from({ length: 25 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 40, deletions: 0 })),
};

async function github(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const path = url.pathname.slice(`/repos/${REPO}`.length);
  if (path === "/pulls") return Response.json(PAGES[url.searchParams.get("page")!]);
  const number = Number(/^\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1]);
  const files = FILES[number] ?? [];
  if (path === `/pulls/${number}`) {
    return Response.json({
      number, title: `Change ${number}`, body: number === 3 ? "Fixes #9" : "", state: "closed", draft: false, user: { login: "ana", type: "User" }, author_association: "CONTRIBUTOR",
      head: { sha: `sha${number}`, ref: "topic" }, base: { ref: "main" }, changed_files: files.length, additions: files.length * 40, deletions: 0,
    });
  }
  if (path === `/pulls/${number}/files`) return Response.json(files);
  if (path.startsWith("/commits/")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: path === "/commits/sha2/check-runs" ? "failure" : "success" }] });
  return Response.json([]);
}

test("repo-scan reads the last closed pull requests through the facts director and measures what was merged", async () => {
  const run = await runLocalWorkflow({
    workflow,
    directors: [triageDirector.factory],
    actions,
    credentialBindings,
    authorize: allow,
    github,
    inference: { credentialId: "none", origin: "https://inference.invalid", apiKey: "none" },
    sourceFor: () => ({ id: "none", provider: "corbits-system-one", baseURL: "https://inference.invalid", credentialId: "none", model: "none" }),
    triggerPayload: { kind: "history", repo: REPO, limit: 100 },
  });
  const { records, unread, buckets } = run.outputs["measure"] as Measured;
  expect(unread).toEqual([]);
  expect(records).toHaveLength(100);
  expect(records.slice(0, 2)).toMatchObject([
    { number: 3, outcome: "merged", docsOnly: true, linkedIssue: true, checks: "success", authorKind: "CONTRIBUTOR", files: 1 },
    { number: 2, outcome: "closed", docsOnly: false, linkedIssue: false, checks: "failure", files: 25 },
  ]);
  expect(buckets.find((b) => b.signal === "files changed" && b.bucket === "> 20")).toEqual({ signal: "files changed", bucket: "> 20", merged: 0, closed: 1 });
});
