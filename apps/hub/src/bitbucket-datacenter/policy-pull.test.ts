import { expect, test } from "bun:test";
import { bitbucketFetch } from "./client.js";
import { openPolicyPull, proposePolicy } from "./policy-pull.js";

const REPO = "ACME/widgets";
const BASE = "/rest/api/1.0/projects/ACME/repos/widgets";
const PATH = ".corbits-triage.yml";

/** Branch name to the file's text and the commit that last changed it. */
const branches = new Map<string, { text?: string; commit: string }>([["main", { commit: "c0" }]]);
const pulls: Array<{ id: number; version: number; title: string; description: string; fromRef: { id: string }; toRef: { id: string }; open: boolean }> = [];
const edits: Array<Record<string, string>> = [];
/** Set, the next commit is followed by another caller opening the pull request first. */
let raced: (typeof pulls)[number] | undefined;

async function bitbucket(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "DELETE" && url.pathname === "/rest/branch-utils/1.0/projects/ACME/repos/widgets/branches") {
    const { name } = await req.json() as { name: string };
    branches.delete(name.slice("refs/heads/".length));
    return new Response(null, { status: 204 });
  }
  const path = url.pathname.slice(BASE.length);
  if (req.method === "GET" && path === "/branches") {
    const filter = url.searchParams.get("filterText") ?? "";
    return Response.json({ values: [...branches.keys()].filter((name) => name.includes(filter)).map((name) => ({ displayId: name, latestCommit: branches.get(name)!.commit })) });
  }
  const at = [...branches].find(([, branch]) => branch.commit === url.searchParams.get("at"))?.[1];
  if (req.method === "GET" && path === `/browse/${PATH}`) return at?.text === undefined ? new Response(null, { status: 404 }) : Response.json({ type: "FILE" });
  if (req.method === "GET" && path === `/raw/${PATH}`) return new Response(at!.text!);
  if (req.method === "GET" && path === "/commits") return Response.json({ values: [{ id: [...branches.values()].find((row) => row.commit === url.searchParams.get("until"))!.commit }] });
  if (req.method === "GET" && path === "") return Response.json({ links: { self: [{ href: "https://bitbucket.test/projects/ACME/repos/widgets/browse" }] } });
  if (req.method === "PUT" && path === `/browse/${PATH}`) {
    expect(req.headers.get("content-type")).toStartWith("multipart/form-data");
    const form = Object.fromEntries(await Promise.all([...(await req.formData()).entries()].map(async ([key, value]) => [key, typeof value === "string" ? value : await value.text()])));
    edits.push(form);
    const from = branches.get(form.sourceBranch ?? form.branch!)!;
    if (form.sourceCommitId !== (from.text === undefined ? undefined : from.commit)) return new Response(null, { status: 409 });
    branches.set(form.branch!, { text: form.content, commit: `c${edits.length}` });
    if (raced) pulls.push(raced);
    raced = undefined;
    return Response.json({ id: `c${edits.length}` });
  }
  if (req.method === "GET" && path === "/pull-requests") {
    return Response.json({ values: pulls.filter((pull) => pull.open && pull.fromRef.id === url.searchParams.get("at")).map(pullJson), isLastPage: true });
  }
  if (req.method === "POST" && path === "/pull-requests") {
    if (pulls.some((pull) => pull.open && pull.fromRef.id === "refs/heads/corbits-triage/policy")) return new Response(null, { status: 409 });
    pulls.push({ id: pulls.length + 1, version: 0, open: true, ...(await req.json() as Omit<(typeof pulls)[number], "id" | "version" | "open">) });
    return Response.json(pullJson(pulls.at(-1)!), { status: 201 });
  }
  if (req.method === "PUT" && path.startsWith("/pull-requests/")) {
    const pull = pulls.find((row) => row.id === Number(path.slice("/pull-requests/".length)))!;
    const body = await req.json() as { version: number; title: string; description: string };
    if (body.version !== pull.version) return new Response(null, { status: 409 });
    Object.assign(pull, { title: body.title, description: body.description, version: pull.version + 1 });
    return Response.json(pullJson(pull));
  }
  return new Response(null, { status: 404 });
}

function pullJson(pull: (typeof pulls)[number]) {
  return { id: pull.id, version: pull.version, links: { self: [{ href: `https://bitbucket.test/projects/ACME/repos/widgets/pull-requests/${pull.id}` }] } };
}

test("the Bitbucket pull request is made once from a new branch, then brought up to date in place", async () => {
  const server = Bun.serve({ port: 0, fetch: bitbucket });
  try {
    const bb = bitbucketFetch(fetch, { baseUrl: `http://127.0.0.1:${server.port}`, address: "127.0.0.1" }, "token");
    expect(await openPolicyPull(bb, REPO)).toBeUndefined();
    const change = { path: PATH, text: "rules: []\n", title: "chore: keep the rules in the file", body: "first" };
    const opened = await proposePolicy(bb, REPO, "main", change);
    expect(opened).toEqual({ number: 1, url: "https://bitbucket.test/projects/ACME/repos/widgets/pull-requests/1" });
    expect(edits[0]).toEqual({ content: "rules: []\n", message: change.title, branch: "corbits-triage/policy", sourceBranch: "main" });
    expect(pulls[0]).toMatchObject({ fromRef: { id: "refs/heads/corbits-triage/policy" }, toRef: { id: "refs/heads/main" } });

    expect(await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Ready }\n", body: "second" })).toEqual(opened);
    expect(edits[1]).toEqual({ content: "rules: []\nlabels: { pass: Ready }\n", message: change.title, branch: "corbits-triage/policy", sourceCommitId: "c1" });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.description).toBe("second");
    expect(await openPolicyPull(bb, REPO)).toEqual(opened);

    // Merged and left behind, the branch starts over from main for the next pull request.
    pulls[0]!.open = false;
    branches.set("main", { text: "rules: []\nlabels: { pass: Ready }\n", commit: "c9" });
    expect(await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\n", body: "third" })).toMatchObject({ number: 2 });
    expect(edits[2]).toEqual({ content: "rules: []\n", message: change.title, branch: "corbits-triage/policy", sourceBranch: "main", sourceCommitId: "c9" });

    // Another caller opening it between the check and the create is answered with theirs.
    pulls[1]!.open = false;
    raced = { id: 3, version: 0, title: change.title, description: "theirs", fromRef: { id: "refs/heads/corbits-triage/policy" }, toRef: { id: "refs/heads/main" }, open: true };
    expect(await proposePolicy(bb, REPO, "main", { ...change, body: "fourth" })).toMatchObject({ number: 3 });
    expect(pulls.filter((pull) => pull.open)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});
