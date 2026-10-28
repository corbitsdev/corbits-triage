// The local sidecar cap with no sandbox to overflow to: a manager placed while the listener and another manager fill
// both slots is refused for capacity and retried, and runs once the other ends.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
const portalDir = mkdtempSync(join(tmpdir(), "corbits-cap-portal-"));
let database: Database;
let hub: Hub;
let workspace: Workspace;

beforeAll(async () => {
  github.addRepo(FIRST, POLICY);
  github.addRepo(SECOND, POLICY);
  const [created] = await Promise.all([createDatabase(), buildPortal(portalDir)]);
  database = created;
  hub = await startHub(database, github, portalDir, { TRIAGE_MAX_LOCAL_SIDECARS: "2" });
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
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.\n${hub.logs.slice(-80).join("\n")}`);
}

type Claim = { status: "live" | "ended"; runId?: string; starts: number; deployAskedAt?: string; history: { head: string; runId: string }[] };

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
  // The listener was asked for the second manager, and no manager has taken its claim yet.
  expect(await claimOf(SECOND)).toMatchObject({ status: "ended", starts: 0, deployAskedAt: expect.any(String), history: [] });

  releaseFirst();
  const second = await until("the second manager to post its verdict", async () => {
    const claim = await claimOf(SECOND);
    return claim !== undefined && claim.history.length === 1 ? claim : undefined;
  });
  expect(second.runId ?? second.history[0]!.runId).not.toBe(first.runId);
  expect(github.pull(SECOND, 1).comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});
