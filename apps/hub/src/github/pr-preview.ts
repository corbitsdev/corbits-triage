// Dry-runs a repository's pack, saved or a candidate, against one open pull
// request: the workflow's own rules and evaluate handlers run here on facts
// read live with the tenant's App. Nothing is written to GitHub or stored, and
// the judge is not run, so the checks it answers come back as needing it.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { getChecks, getReviews, listOpenPrs, listPrCommits, listPrFilesPage, readPr, type GithubFetch } from "@corbits/github-tool/github";
import { checkPackSchema, readCheckPack, repoPolicy, repoPolicySchema, TRIAGE_EVENTS, type CheckPack } from "@corbits/triage-contracts";
import { evaluate } from "../../../../packages/triage-workflows/src/actions/evaluate.js";
import { rules, type RulesItem } from "../../../../packages/triage-workflows/src/actions/rules.js";
import { checkName } from "../../../../packages/triage-workflows/src/logic/actions.js";
import type { PrFileFacts } from "../../../../packages/triage-workflows/src/logic/checks.js";
import { assembleItem, fileFacts, MAX_PATCH_CHARS, type ItemContext } from "../../../../packages/triage-workflows/src/logic/facts.js";
import { previewActions } from "../../../../packages/triage-workflows/src/logic/preview.js";
import { NEEDS_JUDGE_REASON, type Verdict } from "../../../../packages/triage-workflows/src/logic/render.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, triageNs } from "./tenant-config.js";
import { readJson } from "../read-json.js";

export const GITHUB_PR_PREVIEW_PATH = "/api/integrations/github-preview";

export const PreviewBody = type({
  repo: /^[\w.-]+\/[\w.-]+$/,
  number: "number.integer > 0",
  "pack?": checkPackSchema,
  "roles?": repoPolicySchema.get("roles"),
  "event?": type.enumerated(...TRIAGE_EVENTS),
});

const Do = type({
  id: "string",
  branch: "'yes' | 'no' | 'unsure' | 'always'",
  index: "number",
  kind: "string",
  automatic: "boolean",
  reason: "string",
  "effectId?": "string",
  "target?": "Record<string, unknown>",
  "skipped?": "true",
});
const BranchPreview = type({ branch: "'yes' | 'no' | 'unsure' | 'always'", reason: "string", dos: Do.array() });

export const PreviewResponse = type({
  repo: "string",
  number: "number",
  headSha: "string",
  event: type.enumerated(...TRIAGE_EVENTS),
  pack: "'saved' | 'candidate'",
  judge: "'not-needed' | 'not-run'",
  verdict: {
    state: "string",
    priority: "string",
    labels: "string[]",
    owner: "string",
    humanGated: "boolean",
    confidence: "number | 'unknown'",
    degraded: "'inference-outage' | 'error' | null",
    reason: "string",
    nextAction: "string",
    actor: "'author' | 'maintainer' | 'system'",
    feedback: "string",
  },
  checks: type({
    check: "string",
    name: "string",
    kind: "'machine' | 'model'",
    result: "'pass' | 'fail' | 'unconfirmed' | 'needs-judge'",
    reason: "string",
    evidence: "string[]",
  }).array(),
  actions: type({ id: "string", status: "'not-woken'" })
    .or({ id: "string", status: "'skipped'", reason: "string" })
    .or(BranchPreview.and({ id: "string", status: "'decided'" }))
    .or({ id: "string", status: "'waits-on-judge'", branches: BranchPreview.array() })
    .array(),
});

export type GithubPrPreviewDeps = PortalCredentialDeps & {
  githubApiOrigin: string;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
};

type EffectContext = Parameters<typeof rules>[1];

// The rules and evaluate handlers are pure; one that tried to write would fail the preview rather than act.
const NO_EFFECTS: EffectContext = {
  async perform() {
    throw new Error("a preview performs no effects");
  },
};

/** Every file of the pull request, with patches until the evaluation budget is spent, as the facts director reads them. */
async function listFiles(gh: GithubFetch, repo: string, number: number): Promise<PrFileFacts[]> {
  const files: PrFileFacts[] = [];
  let patchChars = 0;
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await listPrFilesPage(gh, repo, number, { offset, patches: patchChars < MAX_PATCH_CHARS });
    const read = page.files.flatMap(fileFacts);
    files.push(...read);
    patchChars += read.reduce((chars, file) => chars + (file.patch?.length ?? 0), 0);
    if (page.next !== undefined && page.next <= offset) throw new Error(`github_list_pr_files did not advance past offset ${offset} for #${number}`);
    offset = page.next;
  }
  return files;
}

/** The candidate pack checked as a stored one is, or why it is refused. */
function candidatePack(raw: unknown, repo: string): CheckPack | string {
  try {
    return readCheckPack(raw, repo);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The rules step's item for an open pull request, read as the facts director reads it, or the error response to return. */
async function readItem(gh: GithubFetch, number: number, context: Omit<ItemContext, "openPrs">): Promise<RulesItem | Response> {
  const { repo } = context;
  try {
    const open = await listOpenPrs(gh, repo);
    if (!open.some((pr) => pr.number === number)) {
      const res = await gh(`/repos/${repo}/pulls/${number}`);
      if (res.status === 404) return failure(404, "pull_request_not_found", `${repo}#${number} does not exist.`);
      if (!res.ok) throw new Error(`github GET /repos/${repo}/pulls/${number} -> ${res.status}`);
      return failure(409, "pull_request_not_open", `${repo}#${number} is not an open pull request.`);
    }
    // readPr, not getPr: a preview reports mergeability as GitHub has it now rather than polling for it.
    const [pr, reviews, commits, files] = await Promise.all([readPr(gh, repo, number), getReviews(gh, repo, number), listPrCommits(gh, repo, number), listFiles(gh, repo, number)]);
    const checks = pr.sha ? await getChecks(gh, repo, pr.sha) : [];
    const openPrs = open.map((p) => ({ number: p.number, title: p.title }));
    return assembleItem(number, { pr, checks, reviews, commits, files }, { ...context, openPrs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(502, "github_failed", `Could not read ${repo}#${number} from GitHub: ${message}.`);
  }
}

export function createGithubPrPreview(deps: GithubPrPreviewDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = PreviewBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const { repo, number, event = "catch-up" } = body;
    const candidate = body.pack === undefined ? undefined : candidatePack(body.pack, repo);
    if (typeof candidate === "string") return failure(400, "invalid_pack", candidate);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    let pack: CheckPack;
    if (candidate !== undefined) pack = candidate;
    else {
      const stored = await deps.readCheckPack(tenantId, repo);
      if (stored.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's check pack is unreadable. Replace it on the repository page.", { reason: stored.reason });
      if (stored.status !== "ok") return failure(409, "needs_setup", "This repository still needs check setup.");
      pack = stored.pack;
    }
    const policy = repoPolicy(body.roles === undefined ? record : { ...record, roles: body.roles });
    const gh = forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, appJson), record.installationId);

    const item = await readItem(gh, number, { repo, policy, pack, event });
    if (item instanceof Response) return item;

    const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, req.signal);
    const ruledItem = ruled.items[0]!;
    const judged = ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem;
    const verdict = await evaluate({ items: [judged], batch: false }, NO_EFFECTS, req.signal) as Verdict;
    const { state, priority, labels, owner, humanGated, confidence, degraded, reason, nextAction, actor, feedback } = verdict;
    const checks = verdict.checks.map((c) => ({
      ...c,
      name: checkName(c.check, pack),
      result: c.kind === "model" && c.reason === NEEDS_JUDGE_REASON ? "needs-judge" as const : c.result,
    }));
    // A degraded verdict suggests nothing, as evaluate does.
    const actions = degraded === null ? previewActions({ facts: judged.facts, checks: verdict.checks, pack, roles: policy.roles }) : [];
    return Response.json({
      repo,
      number,
      headSha: judged.facts.headSha,
      event,
      pack: candidate === undefined ? "saved" : "candidate",
      judge: ruled.needsJudgment ? "not-run" : "not-needed",
      verdict: { state, priority, labels, owner, humanGated, confidence, degraded, reason, nextAction, actor, feedback },
      checks,
      actions,
    });
  };
}
