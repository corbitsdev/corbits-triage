// Dry-runs a repository's pack, saved or a candidate, against one open pull
// request: the workflow's own rules and evaluate handlers run here on facts
// read live with the tenant's App. Nothing is written to GitHub or stored, and
// the judge is not run, so the checks it answers come back as needing it.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { appLogin, authorTeams, getChecks, getReviews, listIssueComments, listOpenPrs, listPrCommits, readPr, type AuthorTeams, type GithubFetch } from "@corbits/github-reads";
import { CheckOutputSchema, checkName, checkPackSchema, emptyPack, readCheckPack, repoPolicy, TRIAGE_EVENTS, VERDICTS, type CheckPack } from "@corbits/triage-contracts";
import { errorText } from "@corbits/common";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { rules, type RulesItem } from "@corbits/triage-workflows/actions/rules";
import { assembleItem, listFiles, namedTeams, type ItemContext } from "@corbits/triage-workflows/logic/facts";
import { previewActions } from "@corbits/triage-workflows/logic/preview";
import { NEEDS_JUDGE_REASON, type Verdict } from "@corbits/triage-workflows/logic/render";
import type { CheckPackRead } from "./check-pack-store.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { repoRecords, triageNs, sourceOf } from "./tenant-config.js";

export const GITHUB_PR_PREVIEW_PATH = "/api/integrations/github-preview";

export const PreviewBody = type({
  repo: /^[\w.-]+\/[\w.-]+$/,
  number: "number.integer > 0",
  "pack?": checkPackSchema,
  "event?": type.enumerated(...TRIAGE_EVENTS),
});

const VerdictWord = type.enumerated(...VERDICTS);
const Do = type({
  list: VerdictWord,
  index: "number",
  kind: "string",
  reason: "string",
  "effectId?": "string",
  "target?": "Record<string, unknown>",
  "skipped?": "true",
  "held?": "true",
});
const ListPreview = type({ verdict: VerdictWord, dos: Do.array() });

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
    verdict: VerdictWord,
    score: "number | null",
    reasons: "string[]",
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
    output: CheckOutputSchema,
  }).array(),
  /** The policy's actions on this head: the verdict's list, or every list while the verdict waits on the judge. */
  actions: type({ status: "'not-woken'" })
    .or(ListPreview.and({ status: "'decided'" }))
    .or({ status: "'waits-on-judge'", lists: ListPreview.array() }),
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

function candidatePack(raw: unknown, repo: string): CheckPack | string {
  try {
    return readCheckPack(raw, repo);
  } catch (err) {
    return errorText(err);
  }
}

/** As in the workflow, a failed membership read leaves every team unknown rather than failing the preview. */
async function readAuthorTeams(gh: GithubFetch, repo: string, author: string, teams: string[]): Promise<AuthorTeams | null> {
  if (!teams.length) return null;
  try {
    return await authorTeams(gh, { repo, author, teams });
  } catch {
    return null;
  }
}

/**
 * The rules step's item for an open pull request, read as the facts director reads it, or the error response to return.
 * Only the teams `trusted` names are read from GitHub; any other team its pack names is left unknown.
 */
async function readItem(gh: GithubFetch, number: number, context: ItemContext, trusted: CheckPack): Promise<RulesItem | Response> {
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
    const [pr, reviews, comments, commits, files] = await Promise.all([
      readPr(gh, repo, number),
      getReviews(gh, repo, number, function login() {
        return appLogin(gh);
      }),
      listIssueComments(gh, repo, number),
      listPrCommits(gh, repo, number),
      listFiles(gh, repo, number),
    ]);
    const checks = pr.sha ? await getChecks(gh, repo, pr.sha) : [];
    const readable = namedTeams(trusted, repo);
    const read = pr.author ? await readAuthorTeams(gh, repo, pr.author, readable) : null;
    const membership = read && { ...read, unknown: [...read.unknown, ...namedTeams(context.pack, repo).filter((team) => !readable.includes(team))] };
    return assembleItem(number, { pr, checks, reviews, comments, commits, files, authorTeams: membership }, context);
  } catch (err) {
    const message = errorText(err);
    return failure(502, "github_failed", `Could not read ${repo}#${number} from GitHub: ${message}.`);
  }
}

export function createGithubPrPreview(deps: GithubPrPreviewDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(body: typeof PreviewBody.infer, { tenantId, principalId }: Member, signal: AbortSignal): Promise<Response> {
    const { repo, number, event = "catch-up" } = body;
    const candidate = body.pack === undefined ? undefined : candidatePack(body.pack, repo);
    if (typeof candidate === "string") return failure(400, "invalid_pack", candidate);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    // The preview reads through the GitHub App only.
    if (sourceOf(record) !== "github") return failure(409, "preview_unsupported", `${repo} is not on GitHub; run triage to see its verdict.`);
    let pack: CheckPack;
    if (candidate !== undefined) pack = candidate;
    else {
      const stored = await deps.readCheckPack(tenantId, repo);
      if (stored.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's policy is unreadable. Replace it on the repository page.", { reason: stored.reason });
      if (stored.status !== "ok") return failure(409, "needs_setup", "This repository still needs a policy.");
      pack = stored.pack;
    }
    const manager = await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage");
    const policy = repoPolicy(record);
    const gh = forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, appJson), record.installationId);

    // A candidate pack's steps name the teams whose membership is read from GitHub, so only those who may manage the workspace can try them.
    const trusted = candidate === undefined || manager ? pack : emptyPack(repo);
    // The preview never asks the judge, so it reads no docs.
    const item = await readItem(gh, number, { repo, policy, pack, events: [event], docs: { docs: {}, rules: {} } }, trusted);
    if (item instanceof Response) return item;

    const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
    const ruledItem = ruled.items[0]!;
    const judged = ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem;
    const verdict = await evaluate({ items: [judged], batch: false }, NO_EFFECTS, signal) as Verdict;
    const { state, priority, labels, owner, humanGated, verdict: word, score, reasons, degraded, reason, nextAction, actor, feedback } = verdict;
    const checks = verdict.checks.map((c) => ({
      ...c,
      name: checkName(pack, c.check),
      result: c.kind === "model" && c.reason === NEEDS_JUDGE_REASON ? "needs-judge" as const : c.result,
    }));
    const waits = reason === NEEDS_JUDGE_REASON ? "waits-on-judge" as const : verdict.actions;
    const actions = previewActions({ facts: judged.facts, checks: verdict.checks, verdict: word, reason, pack }, waits);
    return Response.json({
      repo,
      number,
      headSha: judged.facts.headSha,
      event,
      pack: candidate === undefined ? "saved" : "candidate",
      judge: ruled.needsJudgment ? "not-run" : "not-needed",
      verdict: { state, priority, labels, owner, humanGated, verdict: word, score, reasons, degraded, reason, nextAction, actor, feedback },
      checks,
      actions,
    });
  };
}
