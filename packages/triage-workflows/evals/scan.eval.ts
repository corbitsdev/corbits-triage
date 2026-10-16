// Scan eval: runs the repo-scan definition on Interchange's local runner (the production step invoker, agents and
// directors) over GitHub responses recorded to fixtures, and prints what each repository's history measures. `--record`
// reads GitHub live through `gh` and rewrites the fixtures; each fixture names the head sha of every pull request it holds.
//
//   bun --conditions=intx-src evals/scan.eval.ts [--record]   (in packages/triage-workflows)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { WorkflowAuthorizeFn } from "@intx/workflow";
import * as actions from "../src/actions/index.js";
import { credentialBindings } from "../src/agents.js";
import { triageDirector } from "../src/directors.js";
import type { Bucket, Measured } from "../src/logic/history.js";
import { REPO_SCAN_ADDRESS, workflow } from "../src/repo-scan.js";
import { runLocalWorkflow } from "./run-local.js";

const REPOS = ["corbitsdev/corbits-triage", "honojs/hono"];
const LIMIT = 100;
const GITHUB = "https://api.github.com";

type Recorded = { status: number; body: string };
type Fixture = { repo: string; recordedAt: string; heads: Record<string, string>; responses: Record<string, Recorded> };

const here = new URL(".", import.meta.url).pathname;
const record = process.argv.includes("--record");

function fixturePath(repo: string): string {
  return `${here}scan-fixtures/${repo.replace("/", "__")}.json.gz`;
}

function ghToken(): string {
  const out = Bun.spawnSync(["gh", "auth", "token"]);
  if (out.exitCode !== 0) throw new Error(`gh auth token: ${out.stderr.toString()}`);
  return out.stdout.toString().trim();
}

/** Links, patches, check output and repository objects are most of GitHub's bytes and nothing the scan reads. */
function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (value === null || typeof value !== "object") return value;
  const kept = Object.entries(value).filter(([key]) => !/url$|^(_links|node_id|gravatar_id|patch|output|app|repo)$/.test(key));
  return Object.fromEntries(kept.map(([key, inner]) => [key, slim(inner)]));
}

function requestKey(input: string | URL | Request, init?: RequestInit): { key: string; method: string } {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return { key: `${url.pathname}${url.search}`, method };
}

function liveGithub(responses: Fixture["responses"]) {
  const token = ghToken();
  return async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { key, method } = requestKey(input, init);
    if (method !== "GET") throw new Error(`the scan wrote ${method} ${key}`);
    const res = await fetch(`${GITHUB}${key}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } });
    const text = await res.text();
    const body = res.ok ? JSON.stringify(slim(JSON.parse(text))) : text;
    responses[key] = { status: res.status, body };
    return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
  };
}

function fixtureGithub(fixture: Fixture) {
  return async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { key } = requestKey(input, init);
    const hit = fixture.responses[key];
    if (!hit) throw new Error(`${fixture.repo}: no recorded response for ${key}; run with --record`);
    return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
  };
}

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

function scanMail(repo: string) {
  return {
    headers: { from: "eval@scan.test", to: [`${REPO_SCAN_ADDRESS}@scan.test`] },
    rawHeaders: {},
    parts: [{ contentType: "text/plain", ref: "part-0", text: JSON.stringify({ kind: "history", repo, limit: LIMIT }) }],
  };
}

async function scan(repo: string, github: Parameters<typeof runLocalWorkflow>[0]["github"]): Promise<Measured> {
  const run = await runLocalWorkflow({
    workflow,
    directors: [triageDirector.factory],
    actions,
    credentialBindings,
    authorize: allow,
    github,
    inference: { credentialId: "none", origin: "https://inference.invalid", apiKey: "none" },
    sourceFor: () => ({ id: "none", provider: "corbits-system-one", baseURL: "https://inference.invalid", credentialId: "none", model: "none" }),
    triggerPayload: scanMail(repo),
  });
  const measured = run.outputs["measure"] as Measured | undefined;
  if (!measured) throw new Error(`${repo}: repo-scan ended ${run.terminalStatus} before measure`);
  return measured;
}

function heads(responses: Fixture["responses"], repo: string): Record<string, string> {
  const pull = new RegExp(`^/repos/${repo}/pulls/(\\d+)$`);
  return Object.fromEntries(Object.entries(responses).flatMap(function head([key, { body }]): Array<[string, string]> {
    const number = pull.exec(key)?.[1];
    return number === undefined ? [] : [[number, JSON.parse(body).head.sha]];
  }));
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`;
}

function print(measured: Measured, fixture: Fixture) {
  const merged = measured.records.filter((r) => r.outcome === "merged").length;
  console.log(`\n${measured.repo}: ${measured.records.length} closed pull requests read (recorded ${fixture.recordedAt}), ${merged} merged, ${measured.records.length - merged} closed unmerged, ${measured.unread.length} unread`);
  for (const { number, error } of measured.unread) console.log(`  #${number} unread: ${error}`);
  console.table(measured.buckets.map((b: Bucket) => ({ signal: b.signal, bucket: b.bucket, merged: b.merged, closed: b.closed, "merge rate": percent(b.merged, b.merged + b.closed) })));
}

for (const repo of REPOS) {
  const path = fixturePath(repo);
  if (record) {
    const responses: Fixture["responses"] = {};
    const started = performance.now();
    await scan(repo, liveGithub(responses));
    const fixture: Fixture = { repo, recordedAt: new Date().toISOString(), heads: heads(responses, repo), responses };
    writeFileSync(path, gzipSync(JSON.stringify(fixture)));
    console.log(`${repo}: recorded ${Object.keys(responses).length} responses in ${Math.round((performance.now() - started) / 1000)}s`);
  }
  if (!existsSync(path)) throw new Error(`${repo}: no fixture; run with --record`);
  const fixture = JSON.parse(gunzipSync(readFileSync(path)).toString()) as Fixture;
  print(await scan(repo, fixtureGithub(fixture)), fixture);
}
