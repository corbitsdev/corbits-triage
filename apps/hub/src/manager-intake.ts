// The hub's side of a pull request's manager. In a workspace with a host's listener live, each pull request, waiting,
// held-Do approval and backlog mail is recorded as one event per pull request it names, as a reviewer's result is by
// its route. A pull request whose manager is up is mailed that manager. One with none is sent to the listener, which
// deploys a manager and wakes it. A manager reads the newest recorded mail back through take.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { APPROVE_DO_KIND, repoSourceOf, WAITING_KIND, type RepoSource } from "@corbits/triage-contracts";
import { reviewRequestOf, type PullRequestToReview } from "./pull-request-reader.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import { liveManager, overduePulls, recordEvent, recordOverdueWake, supersede, type PullRequestRef } from "./manager-state.js";

export type ManagerIntakeDeps = {
  db: DB["db"];
  /** The address of the workspace's live listener for the host, if it has one. */
  listener: (tenantId: string, source: RepoSource) => Promise<string | undefined>;
  /** The pull request as its host shows it now, with its diff. */
  readPull: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  /** The repository's open pull requests and their heads, which a backlog mail stands for. */
  openHeads: (tenantId: string, record: RepoRecord) => Promise<{ number: number; headSha: string; draft: boolean }[]>;
  /** The mail as a GitHub workspace's runs read it, naming the App's bot account. */
  withAppLogin: (tenantId: string, payload: Record<string, unknown>) => Promise<unknown>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  /** Stops a run through the stock run lifecycle with the hub's own authority; stopping one already ending is a no-op. */
  cancel: (tenantId: string, runId: string, reason: string) => Promise<void>;
  /** The pull request's mail as its manager takes it, or undefined when none is to be taken, as for a paused pull request. */
  gate: (tenantId: string, record: RepoRecord, number: number, request: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  log: (entry: Record<string, unknown>) => void;
};

/** The mails a manager runs: a pull request's, its head held for CI, a held Do's approval, and a backlog of open ones. */
const MANAGED = new Set<unknown>(["pr", WAITING_KIND, APPROVE_DO_KIND, "backlog"]);

/** One pull request a mail names: its number and head, the request recorded for it, and the event's id. */
type Named = { number: number; head: string; request: Record<string, unknown>; id: string };

/**
 * A webhook's mail carries its delivery id, so a redelivery records nothing new; any other mail is a new event, so a
 * head mailed again, as after its base moved or its CI settled, is triaged again.
 */
function named(request: Record<string, unknown>, number: unknown, head: unknown): Named[] {
  if (typeof number !== "number" || typeof head !== "string") return [];
  return [{ number, head, request, id: typeof request["deliveryId"] === "string" ? request["deliveryId"] : randomUUID() }];
}

/** A reconciler mail names its heads as `items`; each is recorded as a mail for its own pull request. */
function itemsOf(request: Record<string, unknown>, items: readonly unknown[]): Named[] {
  const { items: _items, ...single } = request;
  return items.flatMap(function item(entry) {
    const head = asRecord(entry);
    return named({ ...single, prNumber: head?.["prNumber"], headSha: head?.["headSha"] }, head?.["prNumber"], head?.["headSha"]);
  });
}

/** The tenant domain on a listener address, which a manager's address shares. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) throw new Error(`listener address ${address} has no domain`);
  return address.slice(at + 1);
}

type Delivery = Pick<ManagerIntakeDeps, "db" | "deliver">;

/** Mails the pull request's manager while one is up; false when none is, for the listener to deploy one. */
async function mailedLive(deps: Delivery, tenantId: string, domain: string, pr: PullRequestRef): Promise<boolean> {
  const runId = await liveManager(deps.db, tenantId, pr);
  if (!runId) return false;
  await deps.deliver(tenantId, `${runId}@${domain}`, { kind: "manage", tenantId, repo: pr.repo, repoSource: pr.source, prNumber: pr.number });
  return true;
}

/** Mails the listener the heads of `repo` it deploys a manager for. */
async function deployFor(deps: Delivery, tenantId: string, address: string, source: RepoSource, repo: string, heads: readonly { number: number; head: string }[]): Promise<void> {
  await deps.deliver(tenantId, address, { kind: "pr", repo, ...(source !== "github" && { repoSource: source }), tenantId, items: heads.map((pull) => ({ prNumber: pull.number, headSha: pull.head })) });
}

/**
 * Wakes the manager of a pull request whose reviewer result was recorded, as a host event does: its live manager is
 * mailed, or the listener deploys one. False when the workspace has no listener for the host.
 */
export function createManagerWake(deps: Delivery & Pick<ManagerIntakeDeps, "listener">) {
  return async function wake(tenantId: string, pr: PullRequestRef, head: string): Promise<boolean> {
    const address = await deps.listener(tenantId, pr.source);
    if (!address) return false;
    if (!(await mailedLive(deps, tenantId, domainOf(address), pr))) await deployFor(deps, tenantId, address, pr.source, pr.repo, [{ number: pr.number, head }]);
    return true;
  };
}

type Wake = ReturnType<typeof createManagerWake>;

/**
 * Wakes a manager for each of the tenant's pull requests whose manager has gone while a reviewer result waits for it,
 * or a reviewer of its newest head is past its deadline with no result, so that manager posts the verdict. A wake is
 * recorded once it succeeded; a pull request whose wake fails is logged, the rest are still woken, and the next
 * reconcile pass tries it again.
 */
export function createOverdueWake(deps: Pick<ManagerIntakeDeps, "db" | "log"> & { wake: Wake }) {
  async function wakeOne(tenantId: string, pr: PullRequestRef, head: string): Promise<void> {
    const entry = { tenantId, source: pr.source, repo: pr.repo, number: pr.number, head };
    try {
      if (!(await deps.wake(tenantId, pr, head))) return;
      await recordOverdueWake(deps.db, tenantId, pr);
      deps.log({ level: "info", msg: "manager_woken_overdue", ...entry });
    } catch (err) {
      deps.log({ level: "error", msg: "manager_overdue_wake_failed", ...entry, error: String(err) });
    }
  }

  return async function wakeOverdue(tenantId: string): Promise<void> {
    try {
      for (const { pr, head } of await overduePulls(deps.db, tenantId)) await wakeOne(tenantId, pr, head);
    } catch (err) {
      deps.log({ level: "error", msg: "manager_overdue_wake_failed", tenantId, error: String(err) });
    }
  };
}

export function createManagerIntake(deps: ManagerIntakeDeps) {
  async function recordOf(tenantId: string, repo: string, source: RepoSource): Promise<RepoRecord> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const record = repoRecords(triageNs(tenant?.config)).find((row) => row.name === repo && sourceOf(row) === source);
    if (!record) throw new Error(`${repo} is not connected from ${source}`);
    return record;
  }

  /** The pull requests a mail names; a backlog names every open one. */
  async function pullsOf(tenantId: string, record: RepoRecord, request: Record<string, unknown>): Promise<Named[]> {
    const { kind, items, prNumber, headSha } = request;
    if (kind === APPROVE_DO_KIND) {
      const step = asRecord(request["step"]);
      return named(request, asRecord(request["request"])?.["number"], step?.["headSha"]);
    }
    if (kind === WAITING_KIND) return named(request, prNumber, headSha);
    if (kind === "backlog") {
      const heads = (await deps.openHeads(tenantId, record)).filter((pull) => !pull.draft);
      return heads.flatMap((pull) => named({ ...request, kind: "pr", prNumber: pull.number, headSha: pull.headSha }, pull.number, pull.headSha));
    }
    if (kind !== "pr") return [];
    return Array.isArray(items) ? itemsOf(request, items) : named(request, prNumber, headSha);
  }

  /** The head's review request when the policy turns code review on; a head that moved gets its own at its own intake. */
  async function withReviewRequest(tenantId: string, record: RepoRecord, pull: Named): Promise<Record<string, unknown>> {
    const { request } = pull;
    if (request["kind"] !== "pr" || request["codeReviewRequest"] !== undefined || asRecord(request["codeReview"])?.["on"] !== true) return request;
    const read = await deps.readPull(tenantId, record, pull.number);
    if (read.headSha === pull.head) return { ...request, codeReviewRequest: reviewRequestOf(record, pull.number, read) };
    deps.log({ level: "info", msg: "code_review_head_moved", tenantId, repo: record.name, pr: pull.number, headSha: pull.head, hostHeadSha: read.headSha });
    return request;
  }

  /** Stops each reviewer of the pull request still out on a head older than its newest; a stop that fails is logged. */
  async function stopSuperseded(tenantId: string, pr: PullRequestRef): Promise<void> {
    for (const reviewer of await supersede(deps.db, tenantId, pr)) {
      const entry = { tenantId, source: pr.source, repo: pr.repo, number: pr.number, kind: reviewer.kind, head: reviewer.head, runId: reviewer.runId };
      try {
        await deps.cancel(tenantId, reviewer.runId, "superseded by a newer head");
        deps.log({ level: "info", msg: "reviewer_superseded", ...entry });
      } catch (err) {
        deps.log({ level: "error", msg: "reviewer_supersede_failed", ...entry, error: String(err) });
      }
    }
  }

  /**
   * Records each pull request a mail names. One whose manager is up is mailed that run; the rest go to the listener,
   * which deploys them, including those recorded before a later one failed. True with nothing recorded when the mail
   * names no pull request, as a backlog of a repository with none open; false when the workspace has no listener or
   * the mail is not one a manager runs.
   */
  return async function toListener(tenantId: string, payload: unknown): Promise<boolean> {
    const request = asRecord(payload);
    if (!request || !MANAGED.has(request["kind"])) return false;
    const source = repoSourceOf(request["repoSource"]);
    const address = await deps.listener(tenantId, source);
    const repo = request["repo"] ?? asRecord(request["request"])?.["repo"];
    if (!address || typeof repo !== "string") return false;
    const record = await recordOf(tenantId, repo, source);
    const pulls = await pullsOf(tenantId, record, request);
    const domain = domainOf(address);
    const start: Named[] = [];
    try {
      for (const asked of pulls) {
        const request = await deps.gate(tenantId, record, asked.number, asked.request);
        if (!request) continue;
        const pull = { ...asked, request };
        const recorded = await deps.withAppLogin(tenantId, await withReviewRequest(tenantId, record, pull));
        const pr = { source, repo, number: pull.number };
        await recordEvent(deps.db, tenantId, pr, pull.id, { type: "webhook", head: pull.head, payload: recorded as Record<string, unknown> });
        await stopSuperseded(tenantId, pr);
        if (!(await mailedLive(deps, tenantId, domain, pr))) start.push(pull);
      }
    } finally {
      if (start.length > 0) await deployFor(deps, tenantId, address, source, repo, start);
    }
    return true;
  };
}
