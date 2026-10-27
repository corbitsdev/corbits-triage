// One local sidecar process hosts the listener and two managers at once, and
// each manager receives only its own pull request's mail.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { fakeGithub, OWNER, type Pull } from "./github.ts";
import { stubModel } from "./model.ts";
import { buildPortal, createDatabase, deliver, dropDatabase, listenerStarted, setUpWorkspace, signUp, startHub, type Database, type Hub, type Workspace } from "./stack.ts";

setDefaultTimeout(10 * 60_000);

const FIRST = `${OWNER}/first`;
const SECOND = `${OWNER}/second`;
const POLICY = "rules:\n  - check: max-files-changed\n    text: Flag pull requests over 30 files changed.\n    max: 30\n    reason: The maintainers set it.\n    evidence:\n      - maintainer-stated\n";

const github = fakeGithub();
const model = stubModel(function never(): never {
  throw new Error("No rule needs the judge.");
});
const portalDir = mkdtempSync(join(tmpdir(), "corbits-shared-portal-"));
let database: Database;
let hub: Hub;
let workspace: Workspace;

beforeAll(async () => {
  github.addRepo(FIRST, POLICY);
  github.addRepo(SECOND, POLICY);
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

function pullOf(head: string): Pull {
  return {
    number: 1, title: "fix: widget sizing", body: "Fixes the widget's size.", author: "octocat", head,
    files: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const size = 1;\n+export const size = 2;" }],
    commits: ["fix: widget sizing"], labels: [], comments: [],
  };
}

async function pushed(repo: string, head: string, action: "opened" | "synchronize" = "opened"): Promise<void> {
  const pull = pullOf(head);
  github.open(repo, pull);
  await deliver(hub, workspace, "pull_request", {
    action, installation: { id: 1 }, repository: { full_name: repo },
    pull_request: { number: 1, state: "open", draft: false, head: { sha: head }, user: { login: pull.author }, title: pull.title, body: pull.body },
  });
}

async function rows(query: string): Promise<Record<string, unknown>[]> {
  const { db, close } = createDB(database.config);
  try {
    return [...await db.execute(sql.raw(query))] as Record<string, unknown>[];
  } finally {
    await close();
  }
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.\n${hub.logs.slice(-80).join("\n")}`);
}

type Claim = { status: "live" | "ended"; runId?: string; history: { head: string; runId: string }[] };

async function claimOf(repo: string): Promise<Claim | undefined> {
  const [row] = await rows(`select state from corbits_triage.manager_state where kind = 'claim' and key = 'mgr:github:${repo}#1'`);
  return row?.["state"] as Claim | undefined;
}

test("one local sidecar process hosts the listener and two live managers, each receiving its own mail", async () => {
  const releaseFirst = github.hold(FIRST, 1);
  const releaseSecond = github.hold(SECOND, 1);
  await pushed(FIRST, sha("first-1"));
  await pushed(SECOND, sha("second-1"));
  const first = await until("the first manager's claim", async () => {
    const claim = await claimOf(FIRST);
    return claim?.status === "live" ? claim : undefined;
  });
  const second = await until("the second manager's claim", async () => {
    const claim = await claimOf(SECOND);
    return claim?.status === "live" ? claim : undefined;
  });
  expect(first.runId).not.toBe(second.runId);

  const live = await rows(`select a.id, a.sidecar_id, r.status, coalesce(s.frozen_approval_bundle -> 'projection' ->> 'id', d.name) as workflow from sidecar_allocation a join workflow_run r on r.id = a.anchor_run_id join workflow_definition d on d.id = r.definition_id left join workflow_run_launch_spec s on s.anchor_run_id = r.id where a.status = 'allocated'`);
  expect(live.filter((row) => row["status"] === "running").map((row) => row["workflow"]).sort()).toEqual(["triage-listener-github", "triage-manager-github", "triage-manager-github"]);
  expect(new Set(live.map((row) => row["sidecar_id"])).size).toBe(1);
  expect(hub.logs.filter((line) => line.includes('"msg":"local_sidecar_started"'))).toHaveLength(1);
  expect(readdirSync(join(hub.dataDir, "local-sidecars"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual(["sidecar"]);

  await pushed(FIRST, sha("first-2"), "synchronize");
  await until("the first push's second head to be recorded", async () => {
    const [row] = await rows(`select count(*)::int as recorded from corbits_triage.manager_state where kind = 'event' and key like 'evt:github:${FIRST}#1:%'`);
    return Number(row!["recorded"]) >= 2 || undefined;
  });
  releaseFirst();
  releaseSecond();
  const firstDone = await until("the first manager to finish both heads", async () => {
    const claim = await claimOf(FIRST);
    return claim !== undefined && claim.history.length >= 2 ? claim : undefined;
  });
  const secondDone = await until("the second manager to finish", async () => {
    const claim = await claimOf(SECOND);
    return claim !== undefined && claim.history.length >= 1 ? claim : undefined;
  });
  expect(firstDone.history.map((pass) => pass.runId)).toEqual([first.runId!, first.runId!]);
  expect(firstDone.history.at(-1)!.head).toBe(sha("first-2"));
  expect(secondDone.history).toEqual([expect.objectContaining({ head: sha("second-1"), runId: second.runId })]);
  expect(github.pull(FIRST, 1).comments.map((comment) => comment.body)).toContainEqual(expect.stringContaining("**Triage: Pass**"));
  expect(github.pull(SECOND, 1).comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  const managerAllocations = live.filter((row) => row["workflow"] === "triage-manager-github").map((row) => `'${String(row["id"])}'`).join(",");
  const released = await until("both managers' allocations to be released from the shared sidecar", async () => {
    const found = await rows(`select status, deployment_cleanup_confirmed from sidecar_allocation where id in (${managerAllocations})`);
    return found.every((row) => row["status"] === "released") ? found : undefined;
  });
  expect(released).toEqual([{ status: "released", deployment_cleanup_confirmed: true }, { status: "released", deployment_cleanup_confirmed: true }]);
  const [sidecar] = await rows(`select retired_at from sidecar where id = '${String(live[0]!["sidecar_id"])}'`);
  expect(sidecar!["retired_at"]).toBeNull();
  const listener = await rows(`select a.status, r.status as run from sidecar_allocation a join workflow_run r on r.id = a.anchor_run_id where a.id = '${String(live.find((row) => row["workflow"] === "triage-listener-github")!["id"])}'`);
  expect(listener).toEqual([{ status: "allocated", run: "running" }]);
});
