// The hub's side of a pull request's manager. In a workspace with a host's listener live, each pull request, waiting,
// held-Do approval and backlog mail is recorded as one event per pull request it names, then sent to the listener,
// which deploys the managers itself and wakes them. A manager reads the newest recorded mail back through take.
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { APPROVE_DO_KIND, repoSourceOf, WAITING_KIND, type RepoSource } from "@corbits/triage-contracts";
import { reviewRequestOf, type PullRequestToReview } from "./code-review-feed.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import { recordEvent } from "./manager-state.js";

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
};

/** The mails a manager runs: a pull request's, its head held for CI, a held Do's approval, and a backlog of open ones. */
const MANAGED = new Set<unknown>(["pr", WAITING_KIND, APPROVE_DO_KIND, "backlog"]);

/** One pull request a mail names: its number and head, the request recorded for it, and the event's id. */
type Named = { number: number; head: string; request: Record<string, unknown>; id: string };

function named(request: Record<string, unknown>, number: unknown, head: unknown, key: unknown): Named[] {
  if (typeof number !== "number" || typeof head !== "string") return [];
  const id = typeof request["deliveryId"] === "string" ? request["deliveryId"] : `${String(request["kind"])}:${number}:${String(key)}`;
  return [{ number, head, request, id }];
}

/** A reconciler mail names its heads as `items`; each is recorded as a mail for its own pull request. */
function itemsOf(request: Record<string, unknown>, items: readonly unknown[]): Named[] {
  const { items: _items, ...single } = request;
  return items.flatMap(function item(entry) {
    const head = asRecord(entry);
    return named({ ...single, prNumber: head?.["prNumber"], headSha: head?.["headSha"] }, head?.["prNumber"], head?.["headSha"], head?.["headSha"]);
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
      return named(request, asRecord(request["request"])?.["number"], step?.["headSha"], step?.["effectId"]);
    }
    if (kind === WAITING_KIND) return named(request, prNumber, headSha, headSha);
    if (kind === "backlog") {
      const heads = (await deps.openHeads(tenantId, record)).filter((pull) => !pull.draft);
      return heads.flatMap((pull) => named({ ...request, kind: "pr", prNumber: pull.number, headSha: pull.headSha }, pull.number, pull.headSha, pull.headSha));
    }
    if (kind !== "pr") return [];
    return Array.isArray(items) ? itemsOf(request, items) : named(request, prNumber, headSha, headSha);
  }

  /** The review request for a pull request mail's head when its policy turns code review on, so the manager can hand it on. */
  async function withReviewRequest(tenantId: string, record: RepoRecord, pull: Named): Promise<Record<string, unknown>> {
    const { request } = pull;
    if (request["kind"] !== "pr" || request["codeReviewRequest"] !== undefined || asRecord(request["codeReview"])?.["on"] !== true) return request;
    const read = await deps.readPull(tenantId, record, pull.number);
    return read.headSha === pull.head ? { ...request, codeReviewRequest: reviewRequestOf(record, pull.number, read) } : request;
  }

  /**
   * Records each pull request a mail names and sends the mail to the host's listener; false, with nothing recorded,
   * when the workspace has none or the mail is not one a manager runs.
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
    for (const pull of pulls) {
      const recorded = await deps.withAppLogin(tenantId, await withReviewRequest(tenantId, record, pull));
      await recordEvent(deps.db, tenantId, { source, repo, number: pull.number }, pull.id, { type: "webhook", head: pull.head, payload: recorded as Record<string, unknown> });
    }
    await deps.deliver(tenantId, address, { kind: "pr", repo, ...(source !== "github" && { repoSource: source }), tenantId, items: pulls.map((pull) => ({ prNumber: pull.number, headSha: pull.head })) });
    return true;
  };
}
