import { expect, test } from "bun:test";
import { createTenantOpenPrs } from "./tenant-open-heads.js";

const ref = (id: string) => ({ id: `refs/heads/${id}`, displayId: id, latestCommit: `${id}-head`, repository: { id: 1 } });

function pull(id: number, slug: string) {
  return { id, title: `#${id}`, state: "OPEN", createdDate: 0, updatedDate: 0, fromRef: ref(`b${id}`), toRef: ref("main"), author: { user: { slug }, role: "AUTHOR", status: "UNAPPROVED" }, reviewers: [] };
}

function bitbucketAnswering(applicationProperties: () => Response) {
  return async function bitbucket(path: string): Promise<Response> {
    if (path.startsWith("/rest/api/1.0/projects/TRI/repos/") && path.includes("/pull-requests")) return Response.json({ values: [pull(3, "ada"), pull(4, "triage-bot")], isLastPage: true });
    if (path === "/rest/api/1.0/application-properties") return applicationProperties();
    if (path.startsWith("/rest/api/1.0/users")) return Response.json({ values: [{ id: 7, slug: "triage-bot" }], isLastPage: true });
    return new Response(null, { status: 404 });
  };
}

function listingOver(bitbucket: ReturnType<typeof bitbucketAnswering>) {
  return createTenantOpenPrs({ db: undefined as never, cipher: undefined as never, onKeyMoved: undefined as never, githubApiOrigin: "", tenantBitbucket: async () => bitbucket })("tnt");
}

const repo = (name: string) => ({ name, source: "bitbucket-datacenter" as const, connected: true, enabled: true });

test("a Bitbucket listing marks the pull requests its token's user opened, asking who that is once for every repository", async () => {
  let tokenUserReads = 0;
  const listing = listingOver(
    bitbucketAnswering(function triageBot() {
      tokenUserReads += 1;
      return Response.json({}, { headers: { "x-auserid": "7", "x-ausername": "triage-bot" } });
    }),
  );
  const [widgets, gadgets] = await Promise.all(["TRI/widgets", "TRI/gadgets"].map((name) => listing(repo(name))));
  expect(widgets!.map((pr) => [pr.number, pr.byTriage === true])).toEqual([[3, false], [4, true]]);
  expect(gadgets!.map((pr) => [pr.number, pr.byTriage === true])).toEqual([[3, false], [4, true]]);
  expect(tokenUserReads).toBe(1);
});

test("a Bitbucket listing still lists every pull request, unmarked, when it can't tell who its token is", async () => {
  const listing = listingOver(bitbucketAnswering(() => new Response(null, { status: 401 })));
  const prs = await listing(repo("TRI/widgets"));
  expect(prs!.map((pr) => [pr.number, pr.byTriage === true])).toEqual([[3, false], [4, false]]);
});
