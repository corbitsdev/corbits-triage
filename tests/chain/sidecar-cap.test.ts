// The local sidecar cap with no sandbox to overflow to: a manager placed while the listener and another manager fill
// both slots is refused for capacity and retried, its head reads queued for capacity meanwhile, and it runs once the
// other ends.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { parseTriageState, triageStateName, WAITING_FOR_CAPACITY, type PrTriageRow } from "@corbits/triage-contracts";
import { fakeGithub, OWNER, type Pull } from "./github.ts";
import { DEFAULT_MAIL_HOLD_MS } from "../../apps/hub/src/timings.ts";
import { stubModel } from "./model.ts";
import { buildPortal, createDatabase, deliver, dropDatabase, listenerStarted, POLL_MS, setUpWorkspace, signUp, startHub, type Database, type Hub, type Workspace } from "./stack.ts";

setDefaultTimeout(10 * 60_000);

const FIRST = `${OWNER}/first`;
const SECOND = `${OWNER}/second`;
const POLICY = "rules:\n  - check: max-files-changed\n    text: Flag pull requests over 30 files changed.\n    max: 30\n    reason: The maintainers set it.\n    evidence:\n      - maintainer-stated\n";

const github = fakeGithub();
const model = stubModel(function never(): never {
  throw new Error("No rule needs the judge.");
});
const portalDir = mkdtempSync(join(tmpdir(), "corbits-cap-portal-"));
let database: Database;
let hub: Hub;
let workspace: Workspace;

beforeAll(async () => {
  github.addRepo(FIRST, POLICY);
  github.addRepo(SECOND, POLICY);
  const [created] = await Promise.all([createDatabase(), buildPortal(portalDir)]);
  database = created;
  // The second manager's wake waits out the first manager's whole pass for a slot, so it keeps the production mail hold.
  hub = await startHub(database, github, portalDir, { TRIAGE_MAX_LOCAL_SIDECARS: "2", HUB_MAIL_HOLD_TTL_MS: String(DEFAULT_MAIL_HOLD_MS) });
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

async function pushed(repo: string, head: string): Promise<void> {
  const pull: Pull = {
    number: 1, title: "fix: widget sizing", body: "Fixes the widget's size.", author: "octocat", head,
    files: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const size = 1;\n+export const size = 2;" }],
    commits: ["fix: widget sizing"], labels: [], comments: [],
  };
  github.open(repo, pull);
  await deliver(hub, workspace, "pull_request", {
    action: "opened", installation: { id: 1 }, repository: { full_name: repo },
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

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}.\n${hub.logs.slice(-80).join("\n")}`);
}

async function triageRow(repo: string): Promise<PrTriageRow | undefined> {
  const [stored] = await rows(`select content from artifacts.artifact where tenant_id = '${workspace.tenantId}' and title = '${triageStateName(repo)}' and archived_at is null`);
  return parseTriageState(stored?.["content"], repo)?.prs.find((row) => row.number === 1);
}

/** The refused head once it reads queued for capacity; on a timeout, the error names its claim's runs and its row. */
async function waitingForCapacity(): Promise<PrTriageRow> {
  try {
    return await until("the refused head to read queued for capacity", async () => {
      const row = await triageRow(SECOND);
      return row?.error === WAITING_FOR_CAPACITY ? row : undefined;
    });
  } catch (err) {
    const claim = await claimOf(SECOND);
    const seen = { deployedRunId: claim?.deployedRunId, refusedRunId: claim?.refusedRunId, row: await triageRow(SECOND) };
    throw new Error(`${String(err)}\n${SECOND}: ${JSON.stringify(seen)}`, { cause: err });
  }
}

type Claim = { status: "live" | "ended"; runId?: string; starts: number; deployAskedAt?: string; deployedRunId?: string; refusedRunId?: string; history: { head: string; runId: string }[] };

async function claimOf(repo: string): Promise<Claim | undefined> {
  const [row] = await rows(`select state from corbits_triage.manager_state where kind = 'claim' and key = 'mgr:github:${repo}#1'`);
  return row?.["state"] as Claim | undefined;
}

test("with every local slot taken and no sandbox, a manager waits for one to free and then runs", async () => {
  const releaseFirst = github.hold(FIRST, 1);
  await pushed(FIRST, sha("first-1"));
  const first = await until("the first manager's claim", async () => {
    const claim = await claimOf(FIRST);
    return claim?.status === "live" ? claim : undefined;
  });
  await pushed(SECOND, sha("second-1"));
  const waiting = await until("the second manager's placement to be refused for room", async () => {
    const [row] = await rows("select failure_code from sidecar_allocation where failure_code = 'capacity_unavailable' limit 1");
    return row;
  });
  expect(waiting).toEqual({ failure_code: "capacity_unavailable" });
  expect(hub.logs.some((line) => line.includes('"msg":"local_sidecar_refused"') && line.includes("2 local sidecars already run"))).toBe(true);
  expect(await claimOf(SECOND)).toMatchObject({ status: "ended", starts: 0, deployAskedAt: expect.any(String), history: [] });
  const queued = await waitingForCapacity();
  expect(queued).toMatchObject({ status: "queued", attempts: 0 });

  releaseFirst();
  const second = await until("the second manager to post its verdict", async () => {
    const claim = await claimOf(SECOND);
    return claim !== undefined && claim.history.length === 1 ? claim : undefined;
  });
  expect(second.runId ?? second.history[0]!.runId).not.toBe(first.runId);
  expect(github.pull(SECOND, 1).comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});
