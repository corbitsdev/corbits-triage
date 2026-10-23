import { expect, test } from "bun:test";
import type { ToolFindings } from "../findings.js";
import { readCiAnnotations } from "./ci-annotations.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function host(routes: Record<string, unknown>) {
  return async function fetch(path: string): Promise<Response> {
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    return route === undefined ? new Response("not found", { status: 404 }) : Response.json(routes[route]);
  };
}

const run = { id: 7, name: "lint", status: "completed", conclusion: "failure", started_at: "2026-10-22T00:00:00Z" };

const github = host({
  [`/repos/acme/widgets/commits/${SHA}/check-runs`]: {
    check_runs: [
      { ...run, output: { annotations_count: 2 } },
      { ...run, id: 8, name: "build", output: { annotations_count: 0 } },
    ],
  },
  "/repos/acme/widgets/check-runs/7/annotations": [
    { path: "src/a.ts", start_line: 2, end_line: 2, annotation_level: "failure", title: "no-debugger", message: "debugger left in", raw_details: null },
    { path: "src/b.ts", start_line: 1, end_line: 1, annotation_level: "notice", title: null, message: "slow import", raw_details: null },
  ],
});

const insights = `/rest/insights/1.0/projects/ACME/repos/widgets/commits/${SHA}`;
const bitbucket = host({
  [`${insights}/reports`]: { values: [{ key: "lint-report", title: "lint" }], isLastPage: true },
  [`${insights}/annotations`]: {
    annotations: [
      { reportKey: "lint-report", path: "src/a.ts", line: 2, message: "debugger left in", severity: "HIGH", type: "no-debugger" },
      { reportKey: "lint-report", path: "src/b.ts", line: 1, message: "slow import", severity: "LOW" },
      { reportKey: "lint-report", message: "report-wide note", severity: "LOW" },
    ],
    totalCount: 3,
  },
});

test("GitHub check-run annotations and Code Insights annotations read as the same findings", async () => {
  const expected: ToolFindings = {
    status: "complete",
    findings: [
      { source: "lint", rule: "no-debugger", path: "src/a.ts", line: 2, message: "debugger left in", severity: "error" },
      { source: "lint", path: "src/b.ts", line: 1, message: "slow import", severity: "notice" },
    ],
  };
  expect(await readCiAnnotations(github, { source: "github", repo: "acme/widgets", sha: SHA })).toEqual(expected);
  expect(await readCiAnnotations(bitbucket, { source: "bitbucket-datacenter", repo: "ACME/widgets", sha: SHA })).toEqual(expected);
});

test("a host read that fails is incomplete, never a clean result", async () => {
  for (const checkout of [{ source: "github", repo: "acme/widgets", sha: SHA }, { source: "bitbucket-datacenter", repo: "ACME/widgets", sha: SHA }] as const) {
    expect(await readCiAnnotations(host({}), checkout)).toMatchObject({ status: "incomplete" });
  }
});
