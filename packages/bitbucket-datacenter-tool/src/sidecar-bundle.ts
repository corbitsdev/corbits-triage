import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";
import {
  authorTeams,
  createDocsReader,
  defaultReviewers,
  getChecks,
  getPr,
  getReviews,
  listIssueComments,
  listOpenPrs,
  listPathCommits,
  listPrCommits,
  listPrFilesPage,
  readFileAt,
  readPrDiff,
  readRepoDocsPage,
  readStack,
} from "@corbits/bitbucket-datacenter-reads";
import { cachedLoads, checkTarget } from "@corbits/repo-read-tool/host-reads";
import { linesOf, MAX_LINES } from "@corbits/repo-read-tool/lines";
import { diffHash } from "@corbits/common/diff-hash";

import { ActionNotRunnableError, executeAction, parseActionInput } from "./action";
import { BitbucketRefusal, mirror, readPr, sendCodeReview, setStatus, statusOf, tokenUser, type BitbucketFetch, type BitbucketUser, type TokenUser } from "./bitbucket";

export const CREDENTIAL_HANDLE = "bitbucket-datacenter";

const str = { type: "string" };
const repo = { type: "string", description: "PROJECTKEY/slug" };
function obj(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: "object", properties, required };
}

const READ_DEFINITIONS: ToolDefinition[] = [
  { name: "bitbucket_datacenter_list_open_prs", description: "List open pull requests for a repository, only those into base when it is set.", inputSchema: obj({ repo, base: str }, ["repo"]) },
  { name: "bitbucket_datacenter_get_pr", description: "Get one pull request.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  { name: "bitbucket_datacenter_get_stack", description: "Get the pull requests merged into a pull request's branch, and the open pull request whose branch it is based on.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  { name: "bitbucket_datacenter_get_checks", description: "Get build statuses for a commit sha as check runs, without triage's own verdict status.", inputSchema: obj({ repo, sha: str }) },
  { name: "bitbucket_datacenter_get_reviews", description: "Get each reviewer's standing status on a pull request as a review, marking the token user's own needs-work as triageRequest.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  { name: "bitbucket_datacenter_list_pr_commits", description: "List commits on a pull request.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  { name: "bitbucket_datacenter_list_path_commits", description: "List the default branch's commits that changed a path since an ISO time, newest first, up to 100, and whether the window holds more (truncated).", inputSchema: obj({ repo, path: str, since: str }) },
  { name: "bitbucket_datacenter_pr_diff_hash", description: "Get the hash of a pull request's diff against its base, or null when the diff has no index lines to hash.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  {
    name: "bitbucket_datacenter_list_pr_files",
    description: "List one page of files changed on a pull request from offset, without patches. Call again with next until next is absent.",
    inputSchema: obj({ repo, number: { type: "integer" }, offset: { type: "integer" }, patchOffset: { type: "integer" }, patches: { type: "boolean" } }, ["repo", "number"]),
  },
  {
    name: "bitbucket_datacenter_read_repo_docs",
    description: "Read one page of a repository's docs (its own markdown, README first) and its contribution rules from offset, at ref or the default branch head. Call again with next and the returned ref until next is absent.",
    inputSchema: obj({ repo, ref: str, offset: { type: "integer" } }, ["repo"]),
  },
  { name: "bitbucket_datacenter_list_issue_comments", description: "List comments on a pull request, oldest first.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  { name: "bitbucket_datacenter_codeowners_for_pr", description: "List the default reviewers Data Center names for a pull request, without the author; Data Center has no team reviewers.", inputSchema: obj({ repo, number: { type: "integer" } }) },
  {
    name: "bitbucket_datacenter_author_teams",
    description: "Say which of the given groups (@PROJECT/group or group) the author is a member of. Groups past the first 20, or not listable with the token, are unknown.",
    inputSchema: obj({ repo, author: str, teams: { type: "array", items: str } }),
  },
  {
    name: "bitbucket_datacenter_read_file",
    description: `Read lines start to end (1-based, inclusive) of a file at a commit sha, at most ${MAX_LINES} lines, each prefixed with its line number; with whole, the file's text as it is.`,
    inputSchema: obj({ repo, sha: str, path: str, start: { type: "integer" }, end: { type: "integer" }, whole: { type: "boolean" } }, ["repo", "sha", "path"]),
  },
];

const ARTIFACT_REF = obj({ id: str, version: { type: "number" } });

const MIRROR_INPUT = obj({
  repo,
  number: { type: "integer" },
  labels: { type: "array", items: str, description: "Ignored: Bitbucket Data Center has no labels" },
  owned: { type: "array", items: str },
  comment: str,
  header: {
    ...obj({
      head: str,
      policy: { type: ["object", "null"], properties: { repo: ARTIFACT_REF }, required: ["repo"] },
      verdict: str,
    }),
    description: "What the comment is written for; an unchanged one is not written again",
  },
  build: {
    ...obj({ state: { type: "string", enum: ["SUCCESSFUL", "FAILED", "INPROGRESS"] }, description: str, url: str }, ["state", "description"]),
    description: "The verdict as the Corbits Triage build status on the head; the pull request's own page is its URL when none is given",
  },
  notReadyHead: str,
  fixedHead: str,
  onHead: { ...str, description: "Write nothing once the pull request has moved past this head" },
}, ["repo", "number", "labels"]);

const MIRROR_DESCRIPTION =
  "Post (or update) the triage comment on a Bitbucket Data Center pull request when comment is given, and set the Corbits Triage build status on its head when build is given. While notReadyHead is the head, which may not be approved, takes back the token user's approval; while fixedHead is the head, which leaves the author nothing to fix, takes back its needs-work. Writes nothing to a closed pull request. Never merges.";

const WRITE_DEFINITIONS: ToolDefinition[] = [
  { name: "bitbucket_datacenter_mirror", description: MIRROR_DESCRIPTION, inputSchema: MIRROR_INPUT },
  { name: "bitbucket_datacenter_mirror_auto", description: `${MIRROR_DESCRIPTION} Runs without waiting for a human approval.`, inputSchema: MIRROR_INPUT },
  {
    name: "bitbucket_datacenter_execute_action_auto",
    description:
      "Run one resolved triage action on a Bitbucket Data Center pull request without waiting for a human approval, unless Bitbucket already shows it: add reviewers (code owners are the default reviewers), post a comment, approve, mark needs work (with the body as a comment), decline, or merge. Labels and assignees do not exist there and are skipped with a reason. A decline also upserts the triage comment. A decline, merge, comment or review is refused once the pull request has moved past headSha. Returns { status } as done, satisfied (already on Bitbucket) or skipped with a reason. Merges only for a merge action.",
    inputSchema: obj({ request: MIRROR_INPUT, step: obj({ effectId: str, headSha: str, kind: str, target: { type: "object" } }) }),
  },
  {
    name: "bitbucket_datacenter_send_code_review",
    description: "Post a code review on sha: an inline comment for each finding the diff shows and one summary comment holding the rest. Writes only what is not there yet, and nothing once the pull request has moved past sha. Never merges.",
    inputSchema: obj({ repo, number: { type: "integer" }, sha: str, summary: str, comments: { type: "array", items: { type: "object" } } }),
  },
];

interface Env extends BaseEnv {
  capabilities: RuntimeCapabilities;
}

type ToolCallInput = { id: string; name: string; arguments: Record<string, any> };

/** An action that cannot run is reported, not failed, so the run goes on. */
export async function runAction(bb: BitbucketFetch, args: unknown, user: BitbucketUser) {
  try {
    const { status } = await executeAction(bb, parseActionInput(args), user);
    return { status };
  } catch (err) {
    if (err instanceof ActionNotRunnableError || err instanceof BitbucketRefusal) return { status: "skipped", reason: err.message };
    throw err;
  }
}

/** Takes back the token user's own review status when the head no longer earns it; anyone else's stays. */
async function takeBack(bb: BitbucketFetch, a: Record<string, any>, sha: string, me: TokenUser): Promise<string[]> {
  const status = statusOf(await readPr(bb, a.repo, a.number), me);
  const stale = (status === "APPROVED" && a.notReadyHead === sha) || (status === "NEEDS_WORK" && a.fixedHead === sha);
  if (!stale) return [];
  await setStatus(bb, { repo: a.repo, number: a.number, slug: me.slug, status: "UNAPPROVED" });
  return [status];
}

/** Each file at a commit is fetched once per tool instance however many windows of it are read. */
type Reads = { docs: ReturnType<typeof createDocsReader>; files: ReturnType<typeof cachedLoads<string | undefined>> };

async function readWindow(bb: BitbucketFetch, reads: Reads, a: Record<string, any>) {
  checkTarget(a.repo, a.sha, a.path);
  const text = await reads.files(`${a.repo}@${a.sha}:${a.path}`, () => readFileAt(bb, a.repo, a.sha, a.path));
  if (text === undefined) throw new Error(`${a.path} is not in ${a.repo} at ${a.sha}`);
  if (a.whole === true) return { path: a.path, text };
  return linesOf(a.path, text, a.start, a.end);
}

async function dispatch(bb: BitbucketFetch, call: ToolCallInput, user: BitbucketUser, reads: Reads): Promise<unknown> {
  const a = call.arguments;
  switch (call.name) {
    case "bitbucket_datacenter_list_open_prs":
      return { prs: await listOpenPrs(bb, a.repo, a.base) };
    case "bitbucket_datacenter_get_pr":
      return getPr(bb, a.repo, a.number);
    case "bitbucket_datacenter_get_stack":
      return readStack(bb, a.repo, a.number);
    case "bitbucket_datacenter_get_checks":
      return { checks: await getChecks(bb, a.sha) };
    case "bitbucket_datacenter_get_reviews":
      return { reviews: await getReviews(bb, a.repo, a.number, (await user()).slug) };
    case "bitbucket_datacenter_list_pr_commits":
      return { commits: await listPrCommits(bb, a.repo, a.number) };
    case "bitbucket_datacenter_list_path_commits":
      return listPathCommits(bb, a.repo, a.path, a.since);
    case "bitbucket_datacenter_pr_diff_hash":
      return { hash: diffHash(await readPrDiff(bb, a.repo, a.number)) ?? null };
    case "bitbucket_datacenter_list_pr_files":
      return listPrFilesPage(bb, a.repo, a.number, a.offset);
    case "bitbucket_datacenter_read_repo_docs":
      return readRepoDocsPage(bb, a.repo, { ref: a.ref, offset: a.offset, docs: reads.docs });
    case "bitbucket_datacenter_list_issue_comments":
      return { comments: await listIssueComments(bb, a.repo, a.number) };
    case "bitbucket_datacenter_codeowners_for_pr":
      return defaultReviewers(bb, a.repo, a.number);
    case "bitbucket_datacenter_author_teams":
      return authorTeams(bb, { repo: a.repo, author: a.author, teams: a.teams });
    case "bitbucket_datacenter_read_file":
      return readWindow(bb, reads, a);
    case "bitbucket_datacenter_mirror":
    case "bitbucket_datacenter_mirror_auto": {
      const mirrored = await mirror(bb, { repo: a.repo, number: a.number, labels: a.labels, owned: a.owned, comment: a.comment, header: a.header, build: a.build, onHead: a.onHead, close: false }, user);
      if ("skipped" in mirrored) return mirrored;
      if (a.notReadyHead !== mirrored.sha && a.fixedHead !== mirrored.sha) return mirrored;
      return { ...mirrored, dismissed: await takeBack(bb, a, mirrored.sha, await user()) };
    }
    case "bitbucket_datacenter_execute_action_auto":
      return runAction(bb, a, user);
    case "bitbucket_datacenter_send_code_review":
      return sendCodeReview(bb, { repo: a.repo, number: a.number, sha: a.sha, summary: a.summary, comments: a.comments }, user);
    default:
      throw new Error(`unknown tool ${call.name}`);
  }
}

/** The token user, and each head's docs listing, are asked of Bitbucket once per tool instance, so once per step of a run. */
function createBitbucketTools(definitions: ToolDefinition[], getFetch: () => Promise<BitbucketFetch>) {
  let known: TokenUser | undefined;
  let reads: Reads | undefined;
  async function run(call: ToolCallInput) {
    try {
      const bb = await getFetch();
      reads ??= { docs: createDocsReader(bb), files: cachedLoads() };
      async function user() {
        known ??= await tokenUser(bb);
        return known;
      }
      const content = await dispatch(bb, call, user, reads);
      return { callId: call.id, content: content as Record<string, unknown> };
    } catch (err) {
      return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
  return { definitions, run };
}

/** The tools' calls for a workflow action that holds the credential itself. */
export function bitbucketCalls(getFetch: () => Promise<BitbucketFetch>) {
  return createBitbucketTools([], getFetch).run;
}

function defineBitbucketTool(id: string, definitions: ToolDefinition[], ask: readonly string[]) {
  return defineTool<Env>({
    id,
    requires: ["capabilities"],
    definitions: definitions.map((d) => ({ name: d.name, ...(ask.includes(d.name) ? { approval: "ask" as const } : {}) })),
    factory: function bitbucketToolFactory(env) {
      async function resolveBitbucketFetch(): Promise<BitbucketFetch> {
        const mediated = await env.capabilities.resolve("credentials").resolve(CREDENTIAL_HANDLE);
        if (mediated.kind !== "http") throw new Error(`${CREDENTIAL_HANDLE} credential must be http, got ${mediated.kind}`);
        return function bitbucketFetch(path, init) {
          return mediated.fetch(path, init);
        };
      }
      return createBitbucketTools(definitions, resolveBitbucketFetch);
    },
  });
}

// Read and write are separate bundles, as the GitHub tool's are, so each gets its own credential grant.
export const bitbucketRead = defineBitbucketTool("@corbits/bitbucket-datacenter-tool/sidecar-bundle", READ_DEFINITIONS, []);
export const bitbucketWrite = defineBitbucketTool("@corbits/bitbucket-datacenter-write-tool/sidecar-bundle", WRITE_DEFINITIONS, ["bitbucket_datacenter_mirror", "bitbucket_datacenter_send_code_review"]);
