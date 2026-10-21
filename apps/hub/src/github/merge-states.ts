// Whether the host would merge the listed pull requests now. GitHub answers all
// of them in one GraphQL query; Bitbucket Data Center has no batch read of its
// merge checks. A pull request left out of the answer is not known.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { readMergeStates } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import { failure, sourceCredentialGrant } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { createSourceFetch, type SourceFetchDeps } from "./source-fetch.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";

export const MERGE_STATES_PATH = "/api/integrations/merge-states";

const MergeStatesQuery = type({ repo: /^[\w.-]+\/[\w.-]+$/, numbers: /^[1-9]\d*(,[1-9]\d*)*$/ });

export const MAX_MERGE_STATES = 100;

/** GraphQL's Int. */
const MAX_NUMBER = 2 ** 31 - 1;

const BITBUCKET_CONCURRENCY = 10;

export function createMergeStates(deps: SourceFetchDeps & { log: (entry: Record<string, unknown>) => void }) {
  const sourceFetch = createSourceFetch(deps);

  async function bitbucketMergeState(bb: bitbucket.BitbucketFetch, repo: string, number: number) {
    try {
      return [{ number, ...(await bitbucket.readMergeability(bb, repo, number)) }];
    } catch (err) {
      deps.log({ level: "warn", msg: "merge_state_failed", repo, number, error: errorText(err) });
      return [];
    }
  }

  async function bitbucketMergeStates(bb: bitbucket.BitbucketFetch, repo: string, numbers: number[]) {
    const states = [];
    for (let i = 0; i < numbers.length; i += BITBUCKET_CONCURRENCY) {
      states.push(...(await Promise.all(numbers.slice(i, i + BITBUCKET_CONCURRENCY).map((number) => bitbucketMergeState(bb, repo, number)))).flat());
    }
    return states;
  }

  return async function handle(req: Request, { tenantId, principalId }: Member): Promise<Response> {
    const url = new URL(req.url);
    const query = MergeStatesQuery({ repo: url.searchParams.get("repo"), numbers: url.searchParams.get("numbers") });
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const numbers = [...new Set(query.numbers.split(",").map(Number))];
    if (numbers.length > MAX_MERGE_STATES) return failure(400, "invalid_request", `Ask about at most ${MAX_MERGE_STATES} pull requests at once.`);
    if (numbers.some((number) => number > MAX_NUMBER)) return failure(400, "invalid_request", `A pull request number is at most ${MAX_NUMBER}.`);

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === query.repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${query.repo} is not connected to this workspace.`);
    const refused = await sourceCredentialGrant(deps, principalId, tenantId, record, "read");
    if (refused) return refused;

    try {
      const source = await sourceFetch(tenantId, principalId, record);
      if (!source) throw new Error(`no readable ${sourceOf(record)} credential`);
      if ("gh" in source) return Response.json({ prs: await readMergeStates(source.gh, record.name, numbers) });
      return Response.json({ prs: await bitbucketMergeStates(source.bb, record.name, numbers) });
    } catch (err) {
      const message = errorText(err);
      deps.log({ level: "warn", msg: "merge_states_failed", tenantId, repo: query.repo, error: message });
      return failure(502, "source_failed", `Could not read merge states for ${query.repo} from ${sourceOf(record)}: ${message}.`);
    }
  };
}
