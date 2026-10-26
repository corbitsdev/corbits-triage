// The hub's side of a pull request's manager. In a workspace with a host's listener live, each pull request, waiting,
// held-Do approval and backlog mail is recorded as one event per pull request it names. A pull request whose manager
// is up is mailed that manager. One with none is sent to the listener, which deploys a manager and wakes it. A manager
// reads the newest recorded mail back through take.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { APPROVE_DO_KIND, repoSourceOf, WAITING_KIND, type RepoSource } from "@corbits/triage-contracts";
import { reviewRequestOf, type PullRequestToReview } from "./code-review-feed.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import { liveManager, recordEvent } from "./manager-state.js";

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

  /** The tenant domain on a listener address, which a manager's address shares. */
  function domainOf(address: string): string {
    const at = address.lastIndexOf("@");
    if (at <= 0 || at === address.length - 1) throw new Error(`listener address ${address} has no domain`);
    return address.slice(at + 1);
  }

  /**
   * Records each pull request a mail names. One whose manager is up is mailed that run; the rest go to the listener,
   * which deploys them. False, with nothing recorded, when the workspace has no listener or the mail is not one a
   * manager runs.
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
    if (pulls.length === 0) return false;
    const domain = domainOf(address);
    const start: Named[] = [];
    for (const asked of pulls) {
      const request = await deps.gate(tenantId, record, asked.number, asked.request);
      if (!request) continue;
      const pull = { ...asked, request };
      const recorded = await deps.withAppLogin(tenantId, await withReviewRequest(tenantId, record, pull));
      await recordEvent(deps.db, tenantId, { source, repo, number: pull.number }, pull.id, { type: "webhook", head: pull.head, payload: recorded as Record<string, unknown> });
      const runId = await liveManager(deps.db, tenantId, { source, repo, number: pull.number });
      if (runId) {
        await deps.deliver(tenantId, `${runId}@${domain}`, { kind: "manage", tenantId, repo, repoSource: source, prNumber: pull.number });
      } else {
        start.push(pull);
      }
    }
    if (start.length > 0) {
      await deps.deliver(tenantId, address, { kind: "pr", repo, ...(source !== "github" && { repoSource: source }), tenantId, items: start.map((pull) => ({ prNumber: pull.number, headSha: pull.head })) });
    }
    return true;
  };
}
