// The live chain from a webhook to the pull request: the hub, the listener, one manager per pull request and the judge,
// each on a local sidecar, against a fake GitHub and a stub decision model. Each scenario is a test file of its own,
// which starts this stack for itself with `chainStack()`, so scenarios run at once and none sees another's runs.
import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { listWorkflowDeployments, listWorkflowRuns, readWorkflowRunEvents } from "@intx/hub-client";
import { saveAutomationMode } from "../../apps/web/src/lib/hub-api.ts";
import { fakeGithub, OWNER, type Pull, type Write } from "./github.ts";
import { stubModel, type Answer, type Question } from "./model.ts";
import { buildPortal, createDatabase, deliver, dropDatabase, listenerStarted, setUpWorkspace, signUp, startHub, type Database, type Hub, type Workspace } from "./stack.ts";


const MANAGER = "triage-manager-github";
export const SETTLE_MS = 90_000;

export const DETERMINISTIC = `${OWNER}/deterministic`;
export const JUDGED = `${OWNER}/judged`;
export const WAITING = `${OWNER}/waiting`;
export const PUSHED = `${OWNER}/pushed`;
export const HELD = `${OWNER}/held`;
export const ALWAYS = `${OWNER}/always`;
export const WOKEN = `${OWNER}/woken`;
export const UNWOKEN = `${OWNER}/unwoken`;
export const DISCONNECTED = `${OWNER}/disconnected`;
export const UNSET = `${OWNER}/unset`;

// Interchange's `liveWorkflowRunStatuses`: an anchor is born `deployed` and flips to `running` on its first trigger.
const LIVE_DEPLOYMENT_STATUSES = new Set(["deployed", "running"]);

export function isLiveDeployment(status: string): boolean {
  return LIVE_DEPLOYMENT_STATUSES.has(status);
}

export const MAX_FILES = "  - check: max-files-changed\n    text: Flag pull requests over 30 files changed.\n    max: 30\n";
const FOCUSED = "  - check: focused\n    text: Check the change is focused on one thing.\n";
const CI_GREEN = "  - check: ci-green\n    text: CI must pass before merge.\n";
const ASSIGN_ON_PASS = "actions:\n  pass:\n    - do: assign\n      target:\n        to: users\n        users:\n          - octocat\n";
const REVIEW_ON_PASS = "actions:\n  pass:\n    - do: request-review\n      target:\n        to: users\n        users:\n          - hubot\n";

export function policy(rules: string[], extra = ""): string {
  return `rules:\n${rules.map((rule) => `${rule}    reason: The maintainers set it.\n    evidence:\n      - maintainer-stated\n`).join("")}${extra}`;
}

/** The judge finds every change focused, by the first of a choice's options, and no pull request steering it. */
function decide(id: string, question: Question): Answer {
  if (question.type !== "choice") return { type: "noul", noul: id === "instructed" ? 0.05 : 0.95 };
  const [first, ...rest] = Object.keys(question.criteria as Record<string, string>);
  return { type: "choice", choice: first!, probabilities: { [first!]: 0.96, ...Object.fromEntries(rest.map((option) => [option, 0.04 / rest.length])) }, confidence: 0.96 };
}

export function sha(seed: string): string {
  return new Bun.CryptoHasher("sha1").update(seed).digest("hex");
}

export function pullOf(number: number, head: string): Pull {
  return {
    number, title: "fix: widget sizing", body: "Fixes the widget's size.", author: "octocat", head,
    files: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const size = 1;\n+export const size = 2;" }],
    commits: ["fix: widget sizing"], labels: [], comments: [],
  };
}

export type Claim = { status: "live" | "ended"; runId?: string; history: { head: string; runId: string; doneAt: string }[] };

/** This test file's stack, started before its tests and stopped after them; call it once, at the file's top level. */
export function chainStack() {
  setDefaultTimeout(20 * 60_000);
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
    github.addRepo(ALWAYS, policy([MAX_FILES], REVIEW_ON_PASS));
    github.addRepo(WOKEN, policy([MAX_FILES, FOCUSED]));
    github.addRepo(UNWOKEN, policy([MAX_FILES]));
    github.addRepo(DISCONNECTED, policy([MAX_FILES]));
    github.addRepo(UNSET, null);
    const [created] = await Promise.all([createDatabase(), buildPortal(portalDir)]);
    database = created;
    hub = await startHub(database, github, portalDir);
    workspace = await signUp(hub, database);
    // Until a scenario switches it to policy, only posting runs on its own, so a Do in a policy is held.
    await saveAutomationMode(workspace.transport, workspace.tenantId, "ask");
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

  /** GitHub's webhook for a pull request opened or pushed to, after the fake shows that head. */
  async function pushed(repo: string, pull: Pull, action: "opened" | "synchronize" = "opened"): Promise<void> {
    github.open(repo, pull);
    await deliver(hub, workspace, "pull_request", {
      action, installation: { id: 1 }, repository: { full_name: repo },
      pull_request: { number: pull.number, state: "open", draft: false, head: { sha: pull.head }, user: { login: pull.author }, title: pull.title, body: pull.body },
    });
  }

  type RunEvent = { type: string; body: Record<string, unknown> };

  /** Every event of every run of every deployment once, child runs included, which a deployment also lists, in order. */
  async function eachRunEvent(visit: (runId: string, event: RunEvent) => void): Promise<void> {
    const { transport, tenantId } = workspace;
    const walked = new Set<string>();
    async function walk(deploymentId: string, runId: string): Promise<void> {
      if (walked.has(runId)) return;
      walked.add(runId);
      const { events } = await readWorkflowRunEvents(transport, tenantId, deploymentId, runId);
      for (const event of events) {
        const body = event.body as Record<string, unknown>;
        visit(runId, { type: event.type, body });
        if (event.type === "ChildSpawned") await walk(deploymentId, String(body["childRunId"]));
      }
    }
    for (const deployment of await listWorkflowDeployments(transport, tenantId)) {
      for (const run of await listWorkflowRuns(transport, tenantId, deployment.id)) await walk(deployment.id, run);
    }
  }

  /** Every run of every deployment, step by step, for a failure message. */
  async function runEvents(): Promise<string> {
    const lines: string[] = [];
    let current: string | undefined;
    await eachRunEvent(function dump(runId, { type, body }) {
      if (runId !== current) lines.push(`== ${runId}`);
      current = runId;
      if (type.startsWith("Step") && type !== "StepStarted") lines.push(`${type} ${String(body["stepId"])} ${JSON.stringify(body["output"] ?? body["error"] ?? body["message"]).slice(0, 400)}`);
      else if (type.startsWith("Run")) lines.push(type);
    });
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

  return {
    github,
    model,
    get hub(): Hub {
      return hub;
    },
    get workspace(): Workspace {
      return workspace;
    },
    pushed,
    eachRunEvent,
    until,
    rows,
    claimOf,
    managers,
    settled,
    verdictsOf,
  };
}

export function comments(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.method === "POST" && write.path.endsWith("/comments")).map((write) => String((write.body as { body: string }).body));
}

export function labelled(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.method === "POST" && write.path.endsWith("/labels")).flatMap((write) => (write.body as { labels: string[] }).labels);
}

/** Runs `scenario` once, on the first test that asks for it. */
export function once<T>(scenario: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return function run() {
    started ??= scenario();
    return started;
  };
}
