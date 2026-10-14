import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";

import { ActionNotRunnableError, executeAction, parseActionInput } from "./action";
import { BitbucketRefusal, mirror, readPr, setStatus, statusOf, tokenUser, type BitbucketFetch, type BitbucketUser, type TokenUser } from "./bitbucket";

export const CREDENTIAL_HANDLE = "bitbucket";

const str = { type: "string" };
const repo = { type: "string", description: "PROJECTKEY/slug" };
function obj(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: "object", properties, required };
}

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
      policy: { type: ["object", "null"], properties: { repo: ARTIFACT_REF, shared: ARTIFACT_REF }, required: ["repo"] },
      verdict: str,
    }),
    description: "What the comment is written for; an unchanged one is not written again",
  },
  notReadyHead: str,
  fixedHead: str,
}, ["repo", "number", "labels"]);

const MIRROR_DESCRIPTION =
  "Post (or update) the triage comment on a Bitbucket Data Center pull request when comment is given. While notReadyHead is the head, which may not be approved, takes back the token user's approval; while fixedHead is the head, which leaves the author nothing to fix, takes back its needs-work. Writes nothing to a closed pull request. Never merges.";

const WRITE_DEFINITIONS: ToolDefinition[] = [
  { name: "bitbucket_mirror", description: MIRROR_DESCRIPTION, inputSchema: MIRROR_INPUT },
  { name: "bitbucket_mirror_auto", description: `${MIRROR_DESCRIPTION} Runs without waiting for a human approval.`, inputSchema: MIRROR_INPUT },
  {
    name: "bitbucket_execute_action_auto",
    description:
      "Run one resolved triage action on a Bitbucket Data Center pull request without waiting for a human approval, unless Bitbucket already shows it: add reviewers, post a comment, approve, mark needs work (with the body as a comment), decline, or merge. Labels and assignees do not exist there and are skipped with a reason. A decline also upserts the triage comment. A decline, merge, comment or review is refused once the pull request has moved past headSha. Returns { status } as done, satisfied (already on Bitbucket) or skipped with a reason. Merges only for a merge action.",
    inputSchema: obj({ request: MIRROR_INPUT, step: obj({ effectId: str, headSha: str, kind: str, target: { type: "object" } }) }),
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

async function dispatch(bb: BitbucketFetch, call: ToolCallInput, user: BitbucketUser): Promise<unknown> {
  const a = call.arguments;
  switch (call.name) {
    case "bitbucket_mirror":
    case "bitbucket_mirror_auto": {
      const mirrored = await mirror(bb, { repo: a.repo, number: a.number, labels: a.labels, owned: a.owned, comment: a.comment, header: a.header, close: false }, user);
      if ("skipped" in mirrored) return mirrored;
      if (a.notReadyHead !== mirrored.sha && a.fixedHead !== mirrored.sha) return mirrored;
      return { ...mirrored, dismissed: await takeBack(bb, a, mirrored.sha, await user()) };
    }
    case "bitbucket_execute_action_auto":
      return runAction(bb, a, user);
    default:
      throw new Error(`unknown tool ${call.name}`);
  }
}

/** The token user is asked of Bitbucket once per tool instance, so once per step of a run. */
function createBitbucketTools(definitions: ToolDefinition[], getFetch: () => Promise<BitbucketFetch>) {
  let known: TokenUser | undefined;
  async function run(call: ToolCallInput) {
    try {
      const bb = await getFetch();
      async function user() {
        known ??= await tokenUser(bb);
        return known;
      }
      const content = await dispatch(bb, call, user);
      return { callId: call.id, content: content as Record<string, unknown> };
    } catch (err) {
      return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
  return { definitions, run };
}

export const bitbucketWrite = defineTool<Env>({
  id: "@corbits/bitbucket-datacenter-tool/sidecar-bundle",
  requires: ["capabilities"],
  definitions: WRITE_DEFINITIONS.map((d) => ({ name: d.name, ...(d.name === "bitbucket_mirror" ? { approval: "ask" as const } : {}) })),
  factory: function bitbucketToolFactory(env) {
    async function resolveBitbucketFetch(): Promise<BitbucketFetch> {
      const mediated = await env.capabilities.resolve("credentials").resolve(CREDENTIAL_HANDLE);
      if (mediated.kind !== "http") throw new Error(`bitbucket credential must be http, got ${mediated.kind}`);
      return function bitbucketFetch(path, init) {
        return mediated.fetch(path, init);
      };
    }
    return createBitbucketTools(WRITE_DEFINITIONS, resolveBitbucketFetch);
  },
});
