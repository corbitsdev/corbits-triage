// The live chain from a webhook to the pull request: the hub, the listener, one manager per pull request and the judge,
// each on a local sidecar, against a fake GitHub and a stub decision model. Each scenario runs once, on a
// repository of its own, and its tests read what it left behind.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { listWorkflowDeployments, listWorkflowRuns, readWorkflowRunEvents } from "@intx/hub-client";
import { VERDICT_LABELS, WAITING_LABEL } from "@corbits/triage-contracts";
import { approveHeldDo } from "../../apps/web/src/lib/hub-api.ts";
import { fakeGithub, OWNER, type Pull, type Write } from "./github.ts";
import { stubModel, type Answer, type Question } from "./model.ts";
import { buildPortal, createDatabase, deliver, dropDatabase, listenerStarted, setUpWorkspace, signUp, startHub, type Database, type Hub, type Workspace } from "./stack.ts";

setDefaultTimeout(20 * 60_000);

const MANAGER = "triage-manager-github";
const SETTLE_MS = 90_000;

const DETERMINISTIC = `${OWNER}/deterministic`;
const JUDGED = `${OWNER}/judged`;
const WAITING = `${OWNER}/waiting`;
const PUSHED = `${OWNER}/pushed`;
const HELD = `${OWNER}/held`;

// Interchange's `liveWorkflowRunStatuses`: an anchor is born `deployed` and flips to `running` on its first trigger.
const LIVE_DEPLOYMENT_STATUSES = new Set(["deployed", "running"]);

function isLiveDeployment(status: string): boolean {
  return LIVE_DEPLOYMENT_STATUSES.has(status);
}

const MAX_FILES = "  - check: max-files-changed\n    text: Flag pull requests over 30 files changed.\n    max: 30\n";
const FOCUSED = "  - check: focused\n    text: Check the change is focused on one thing.\n";
const CI_GREEN = "  - check: ci-green\n    text: CI must pass before merge.\n";
const ASSIGN_ON_PASS = "actions:\n  pass:\n    - do: assign\n      target:\n        to: users\n        users:\n          - octocat\n";

function policy(rules: string[], extra = ""): string {
  return `rules:\n${rules.map((rule) => `${rule}    reason: The maintainers set it.\n    evidence:\n      - maintainer-stated\n`).join("")}${extra}`;
}

/** The judge finds every change focused, by the first of a choice's options, and no pull request steering it. */
function decide(id: string, question: Question): Answer {
  if (question.type !== "choice") return { type: "noul", noul: id === "instructed" ? 0.05 : 0.95 };
  const [first, ...rest] = Object.keys(question.criteria as Record<string, string>);
  return { type: "choice", choice: first!, probabilities: { [first!]: 0.96, ...Object.fromEntries(rest.map((option) => [option, 0.04 / rest.length])) }, confidence: 0.96 };
}

const github = fakeGithub();
const model = stubModel(decide);
const portalDir = mkdtempSync(join(tmpdir(), "corbits-chain-portal-"));
let database: Database;
let hub: Hub;
let workspace: Workspace;

beforeAll(async () => {
  github.addRepo(DETERMINISTIC, policy([MAX_FILES]));
  github.addRepo(JUDGED, policy([MAX_FILES, FOCUSED]));
  github.addRepo(WAITING, policy([CI_GREEN]));
  github.addRepo(PUSHED, policy([MAX_FILES]));
  github.addRepo(HELD, policy([MAX_FILES], ASSIGN_ON_PASS));
  const [created] = await Promise.all([createDatabase(), buildPortal(portalDir)]);
  database = created;
  hub = await startHub(database, github, portalDir);
  workspace = await signUp(hub, database);
  await setUpWorkspace(workspace, github, model.origin);
  await listenerStarted(workspace);
});

afterAll(async () => {
  await hub?.stop();
  if (database) await dropDatabase(database);
  github.stop();
  model.stop();
  rmSync(portalDir, { recursive: true, force: true });
});

function sha(seed: string): string {
  return new Bun.CryptoHasher("sha1").update(seed).digest("hex");
}

function pullOf(number: number, head: string): Pull {
  return {
    number, title: "fix: widget sizing", body: "Fixes the widget's size.", author: "octocat", head,
    files: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const size = 1;\n+export const size = 2;" }],
    commits: ["fix: widget sizing"], labels: [], comments: [],
  };
}

/** GitHub's webhook for a pull request opened or pushed to, after the fake shows that head. */
async function pushed(repo: string, pull: Pull, action: "opened" | "synchronize" = "opened"): Promise<void> {
  github.open(repo, pull);
  await deliver(hub, workspace, "pull_request", {
    action, installation: { id: 1 }, repository: { full_name: repo },
    pull_request: { number: pull.number, state: "open", draft: false, head: { sha: pull.head }, user: { login: pull.author }, title: pull.title, body: pull.body },
  });
}

/** Every run of every deployment, step by step, for a failure message. */
async function runEvents(): Promise<string> {
  const { transport, tenantId } = workspace;
  const lines: string[] = [];
  async function dump(deploymentId: string, runId: string): Promise<void> {
    const { events } = await readWorkflowRunEvents(transport, tenantId, deploymentId, runId);
    lines.push(`== ${runId}`);
    for (const event of events) {
      const body = event.body as Record<string, unknown>;
      if (event.type === "ChildSpawned") await dump(deploymentId, String(body["childRunId"]));
      else if (event.type.startsWith("Step") && event.type !== "StepStarted") lines.push(`${event.type} ${String(body["stepId"])} ${JSON.stringify(body["output"] ?? body["error"] ?? body["message"]).slice(0, 400)}`);
      else if (event.type.startsWith("Run")) lines.push(event.type);
    }
  }
  for (const deployment of await listWorkflowDeployments(transport, tenantId)) {
    for (const run of await listWorkflowRuns(transport, tenantId, deployment.id)) await dump(deployment.id, run);
  }
  return lines.join("\n");
}

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, ms = SETTLE_MS): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.\nRuns:\n${await runEvents()}\nGitHub misses: ${github.misses.join(", ")}`);
}

async function rows(query: string): Promise<Record<string, unknown>[]> {
  const { db, close } = createDB(database.config);
  try {
    return [...await db.execute(sql.raw(query))] as Record<string, unknown>[];
  } finally {
    await close();
  }
}

type Claim = { status: "live" | "ended"; runId?: string; history: { head: string; runId: string; doneAt: string }[] };

async function claimOf(repo: string, number: number): Promise<Claim | undefined> {
  const [row] = await rows(`select state from corbits_triage.manager_state where kind = 'claim' and key = 'mgr:github:${repo}#${number}'`);
  return row?.["state"] as Claim | undefined;
}

/** Every manager deployment's anchor run, oldest first. */
async function managers(): Promise<{ id: string; createdAt: Date; status: string }[]> {
  const found = await rows(`select r.id, r.created_at, r.status from workflow_run r join workflow_definition d on d.id = r.definition_id left join workflow_run_launch_spec s on s.anchor_run_id = r.id where r.id = r.anchor_run_id and coalesce(s.frozen_approval_bundle -> 'projection' ->> 'id', d.name) = '${MANAGER}' order by r.created_at`);
  return found.map((row) => ({ id: String(row["id"]), createdAt: new Date(String(row["created_at"])), status: String(row["status"]) }));
}

/** The claim once its manager's run is gone, whether done ended the claim or the run stopped without ending it. */
async function settled(repo: string, number: number, passes = 1): Promise<Claim> {
  return until(`${repo}#${number}'s manager to stop`, async function stopped() {
    const claim = await claimOf(repo, number);
    if (!claim || claim.history.length < passes) return undefined;
    const runs = await managers();
    const runId = claim.runId ?? claim.history.at(-1)!.runId;
    const live = runs.some((run) => run.id === runId && isLiveDeployment(run.status));
    return live ? undefined : claim;
  });
}

async function verdictsOf(repo: string, number: number): Promise<Record<string, unknown>[]> {
  return rows(`select run_id, head_sha, state, run_status, dos, detail from corbits_triage.verdict where repo = '${repo}' and number = ${number} order by verdict_at`);
}

function comments(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.method === "POST" && write.path.endsWith("/comments")).map((write) => String((write.body as { body: string }).body));
}

function labelled(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.method === "POST" && write.path.endsWith("/labels")).flatMap((write) => (write.body as { labels: string[] }).labels);
}

/** Runs `scenario` once, on the first test that asks for it. */
function once<T>(scenario: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return function run() {
    started ??= scenario();
    return started;
  };
}

/** Scenarios run one after another, so each counts the managers it deployed; one that failed is reported by its own tests. */
async function after(previous: () => Promise<unknown>): Promise<void> {
  try {
    await previous();
  } catch {
    // Its own tests report it.
  }
}

const deterministic = once(async function deterministic() {
  const head = sha("deterministic-1");
  const [before, missed] = [(await managers()).length, github.misses.length];
  await pushed(DETERMINISTIC, pullOf(1, head));
  const claim = await settled(DETERMINISTIC, 1);
  return { head, claim, deployed: (await managers()).slice(before), writes: github.writesTo(DETERMINISTIC, 1), misses: github.misses.slice(missed) };
});

test("a policy of only deterministic rules posts its verdict at once and the manager stops", async () => {
  const { head, claim, deployed, writes, misses } = await deterministic();
  expect(misses).toEqual([]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  expect(claim).toMatchObject({ status: "ended", history: [{ head, runId: deployed[0]!.id }] });
  expect(deployed).toHaveLength(1);
  expect(isLiveDeployment(deployed[0]!.status)).toBe(false);
  expect(model.decisions).toEqual([]);
});

test("the hub records the verdict from the manager's done", async () => {
  const { head, claim } = await deterministic();
  expect(await verdictsOf(DETERMINISTIC, 1)).toEqual([expect.objectContaining({ run_id: claim.history[0]!.runId, head_sha: head, run_status: "completed" })]);
});

const judged = once(async function judged() {
  const head = sha("judged-1");
  await after(deterministic);
  const [asked, missed] = [model.decisions.length, github.misses.length];
  await pushed(JUDGED, pullOf(1, head));
  await settled(JUDGED, 1);
  return { head, asked: model.decisions.slice(asked).map((row) => row.id), writes: github.writesTo(JUDGED, 1), misses: github.misses.slice(missed) };
});

test("a policy that needs the judge deploys it and posts the judge's verdict once", async () => {
  const { head, asked, writes, misses } = await judged();
  expect(misses).toEqual([]);
  expect(asked).toContain("focused");
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  // The pass that deployed the judge reported no verdict, so only the judge's is recorded.
  expect(await verdictsOf(JUDGED, 1)).toEqual([expect.objectContaining({ head_sha: head, state: "ready-monitoring" })]);
});

const waiting = once(async function waiting() {
  const head = sha("waiting-1");
  await after(judged);
  const missed = github.misses.length;
  github.setChecks(WAITING, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(WAITING, pullOf(1, head));
  const held = await settled(WAITING, 1);
  const whileWaiting = [...github.writesTo(WAITING, 1)];
  github.setChecks(WAITING, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  await deliver(hub, workspace, "check_run", {
    action: "completed", installation: { id: 1 }, repository: { full_name: WAITING },
    check_run: { head_sha: head, status: "completed", conclusion: "success", pull_requests: [{ number: 1, head: { sha: head } }] },
  });
  const claim = await settled(WAITING, 1, held.history.length + 1);
  return { head, whileWaiting, claim, pull: github.pull(WAITING, 1), misses: github.misses.slice(missed) };
});

test("a head held for CI is marked waiting, and its check run's completion settles it", async () => {
  const { head, whileWaiting, claim, pull, misses } = await waiting();
  expect(misses).toEqual([]);
  expect(labelled(whileWaiting)).toEqual([WAITING_LABEL]);
  expect(comments(whileWaiting)).toEqual([]);
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(claim.status).toBe("ended");
  expect(claim.history.at(-1)!.head).toBe(head);
});

const pushedAgain = once(async function pushedAgain() {
  const [first, second, third] = [sha("pushed-1"), sha("pushed-2"), sha("pushed-3")];
  await after(waiting);
  const [before, missed] = [(await managers()).length, github.misses.length];
  // The manager's pass reads the files, so holding them keeps it up while the second push arrives.
  const release = github.hold(PUSHED, 1);
  await pushed(PUSHED, pullOf(1, first));
  await until("the manager to claim the pull request", async () => (await claimOf(PUSHED, 1))?.status === "live" || undefined);
  await pushed(PUSHED, pullOf(1, second), "synchronize");
  await until("the second push to be recorded", async () => {
    const [row] = await rows(`select count(*)::int as recorded from corbits_triage.manager_state where kind = 'event' and key like 'evt:github:${PUSHED}#1:%'`);
    return Number(row!["recorded"]) >= 2 || undefined;
  });
  release();
  const alive = await settled(PUSHED, 1, 2);
  const afterTwo = (await managers()).slice(before);
  await pushed(PUSHED, pullOf(1, third), "synchronize");
  const claim = await settled(PUSHED, 1, alive.history.length + 1);
  return { second, third, alive, afterTwo, claim, deployed: (await managers()).slice(before), misses: github.misses.slice(missed) };
});

test("a push while the manager is up is mailed to it, and one after it stopped deploys the next, never two at once", async () => {
  const { second, third, alive, afterTwo, claim, deployed, misses } = await pushedAgain();
  expect(misses).toEqual([]);
  expect(afterTwo).toHaveLength(1);
  expect(new Set(alive.history.map((pass) => pass.runId))).toEqual(new Set([afterTwo[0]!.id]));
  expect(alive.history.at(-1)!.head).toBe(second);
  expect(deployed).toHaveLength(2);
  expect(claim.history.at(-1)).toMatchObject({ head: third, runId: deployed[1]!.id });
  expect(deployed[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(new Date(alive.history.at(-1)!.doneAt).getTime() - 1_000);
});

const approved = once(async function approved() {
  const head = sha("held-1");
  await after(pushedAgain);
  const missed = github.misses.length;
  await pushed(HELD, pullOf(1, head));
  await settled(HELD, 1);
  const writes = [...github.writesTo(HELD, 1)];
  const [verdict] = await verdictsOf(HELD, 1);
  return { head, writes, verdict, misses: github.misses.slice(missed) };
});

test("a Do the policy does not run on its own is held", async () => {
  const { head, writes, verdict, misses } = await approved();
  expect(misses).toEqual([]);
  expect(verdict).toMatchObject({ head_sha: head, dos: [{ list: "pass" }], detail: { actions: [expect.objectContaining({ list: "pass", kind: "assign", target: { users: ["octocat"] }, held: true })] } });
  expect(writes.some((write) => write.path.endsWith("/assignees"))).toBe(false);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});

test("a held Do approved through the hub runs once on the pull request", async () => {
  const { verdict } = await approved();
  // The verdict's one Do is the held assign, whose effect id its recorded Dos keep.
  const [held] = verdict!["dos"] as { effectId: string }[];
  await approveHeldDo(workspace.transport, workspace.tenantId, { runId: String(verdict!["run_id"]), repo: HELD, number: 1, effectId: held!.effectId, kind: "assign" });
  await until("the assignment", () => github.writesTo(HELD, 1).find((write) => write.path.endsWith("/assignees")));
  await settled(HELD, 1, 2);
  expect(github.writesTo(HELD, 1).filter((write) => write.path.endsWith("/assignees"))).toEqual([expect.objectContaining({ method: "POST", body: { assignees: ["octocat"] } })]);
});
