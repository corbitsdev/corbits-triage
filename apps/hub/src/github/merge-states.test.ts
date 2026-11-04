import { expect, test } from "bun:test";
import type { RepoSource } from "@corbits/triage-contracts";
import { createRepoReads } from "./repo-reads.js";
import type { RepoRecord } from "./tenant-config.js";
import { createMergeStates } from "./merge-states.js";

const REPO = "acme/widgets";
const GITHUB: RepoRecord = { name: REPO, connected: true };
const BITBUCKET: RepoRecord = { name: REPO, source: "bitbucket-datacenter", connected: true };

/** Which host the read actually used: Bitbucket answers mergeability; GitHub is asked for an App key it does not have here. */
function readsOf(repos: RepoRecord[]) {
  const hosts: RepoSource[] = [];
  const merge = createMergeStates({
    githubApiOrigin: "https://api.github.test",
    log() {},
    cipher: { async decrypt() { return "not-an-app"; } },
    authorize: async () => true,
    db: {
      query: {
        tenant: { async findFirst() { return { config: { corbitsTriage: { repos } }, parentId: null }; } },
        credential: { async findFirst() { return { id: "crd_host", status: "active", principalId: null, secret: "sealed", metadata: { appSlug: "triage" } }; } },
      },
    },
    tenantBitbucket: async () => {
      hosts.push("bitbucket-datacenter");
      return async function bitbucket() {
        return Response.json({ canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] });
      };
    },
    reads: createRepoReads(() => new Date(0)),
  } as unknown as Parameters<typeof createMergeStates>[0]);
  return { hosts, merge };
}

async function asked(repos: RepoRecord[], source?: RepoSource) {
  const { hosts, merge } = readsOf(repos);
  const query = source === undefined ? "" : `&source=${source}`;
  const res = await merge(new Request(`http://hub.test/merge-states?repo=${REPO}&numbers=7${query}`), { tenantId: "tnt", principalId: "prn" });
  return { hosts, status: res.status, body: await res.json() };
}

test("a merge-state read names the Bitbucket record when a GitHub row of the same name is first", async () => {
  const read = await asked([GITHUB, BITBUCKET], "bitbucket-datacenter");
  expect(read.hosts).toEqual(["bitbucket-datacenter"]);
  expect(read.status).toBe(200);
  expect(read.body).toEqual({ prs: [{ number: 7, mergeable: true, canMerge: true, mergeVetoes: [] }] });
});
