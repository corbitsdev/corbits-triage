import { expect, test } from "bun:test";
import { BitbucketFailed, bitbucketFetch } from "./client.js";
import { bodyWith, DescriptionNotUpdated, PolicyFileMoved } from "../github/policy-pull.js";
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
/** Each commit made through the browse API, newest last. */
const log: Array<{ branch: string; id: string; message: string }> = [];
/** How many description edits fail next. */
let pullPutFailures = 0;
/** Set, the description is edited on Bitbucket just before the next edit, so that edit's version is stale. */
let editedBeforePut = false;
/** Set, the policy file appears on the branch just before the next commit. */
let appearsBeforePut: string | undefined;

async function bitbucket(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "DELETE" && url.pathname === "/rest/branch-utils/1.0/projects/ACME/repos/widgets/branches") {
    const { name } = await req.json() as { name: string };
    branches.delete(name.slice("refs/heads/".length));
    log.splice(0, log.length, ...log.filter((row) => row.branch !== name.slice("refs/heads/".length)));
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
    if (appearsBeforePut !== undefined) branches.set(form.branch!, { text: appearsBeforePut, commit: "c-appeared" });
    appearsBeforePut = undefined;
    const from = branches.get(form.sourceBranch ?? form.branch!)!;
    if (form.sourceCommitId !== (from.text === undefined ? undefined : from.commit)) return new Response(null, { status: 409 });
    branches.set(form.branch!, { text: form.content, commit: `c${edits.length}` });
    log.push({ branch: form.branch!, id: `c${edits.length}`, message: form.message! });
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
  if (req.method === "GET" && /^\/pull-requests\/\d+\/commits$/.test(path)) {
    const pull = pulls.find((row) => row.id === Number(path.split("/")[2]))!;
    const all = log.filter((row) => `refs/heads/${row.branch}` === pull.fromRef.id).toReversed();
    const start = Number(url.searchParams.get("start") ?? "0");
    const end = start + Number(url.searchParams.get("limit") ?? "25");
    const values = all.slice(start, end).map((row) => ({ id: row.id, message: row.message, author: { name: "triage" }, committerTimestamp: 0 }));
    return Response.json({ values, isLastPage: end >= all.length, ...(end < all.length && { nextPageStart: end }) });
  }
  if (req.method === "GET" && path.startsWith("/pull-requests/")) return Response.json(pullJson(pulls.find((row) => row.id === Number(path.slice("/pull-requests/".length)))!));
  if (req.method === "PUT" && path.startsWith("/pull-requests/")) {
    if (pullPutFailures > 0) {
      pullPutFailures -= 1;
      return new Response(null, { status: 502 });
    }
    const pull = pulls.find((row) => row.id === Number(path.slice("/pull-requests/".length)))!;
    if (editedBeforePut) Object.assign(pull, { description: `${pull.description}\n\nedited on Bitbucket`, version: pull.version + 1 });
    editedBeforePut = false;
    const body = await req.json() as { version: number; title: string; description: string };
    if (body.version !== pull.version) return new Response(null, { status: 409 });
    Object.assign(pull, { title: body.title, description: body.description, version: pull.version + 1 });
    return Response.json(pullJson(pull));
  }
  return new Response(null, { status: 404 });
}

function pullJson(pull: (typeof pulls)[number]) {
  return { id: pull.id, version: pull.version, title: pull.title, description: pull.description, fromRef: { latestCommit: "head" }, links: { self: [{ href: `https://bitbucket.test/projects/ACME/repos/widgets/pull-requests/${pull.id}` }] } };
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

    expect(await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Go }\n", title: "chore: another title", body: "appended", append: true })).toEqual(opened);
    expect(pulls[0]!.title).toBe(change.title);
    expect(pulls[0]!.description).toStartWith("second\n\n");
    expect(pulls[0]!.description).toEndWith("\nappended");
    const appended = pulls[0]!.description;
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Go }\n", body: "unchanged", append: true });
    expect(pulls[0]!.description).toBe(appended);
    await expect(proposePolicy(bb, REPO, "main", { ...change, text: "rules: [] # stale\n", body: "stale", append: true, readSha: "c1" })).rejects.toBeInstanceOf(PolicyFileMoved);
    expect(pulls[0]!.description).toBe(appended);

    // A description edit that keeps failing names the commit that landed, and the next batch adds its section.
    pullPutFailures = 4;
    const lost = proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Lost }\n", body: "lost", append: true });
    await expect(lost).rejects.toBeInstanceOf(DescriptionNotUpdated);
    await expect(lost).rejects.toMatchObject({ commit: log.at(-1)!.id });
    expect(pulls[0]!.description).not.toContain("lost");
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Found }\n", body: "found", append: true });
    expect(pulls[0]!.description).toStartWith(appended);
    expect(pulls[0]!.description).toMatch(/\nlost\n[\s\S]*\nfound$/);

    // A description edited on Bitbucket between the read and the edit is read again and keeps both.
    editedBeforePut = true;
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Raced }\n", body: "raced", append: true });
    expect(pulls[0]!.description).toContain("\nedited on Bitbucket\n");
    expect(pulls[0]!.description).toEndWith("\nraced");

    // An export's refused edit is Bitbucket's refusal, sent once and not retried.
    pullPutFailures = 1;
    await expect(proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Export }\n", body: "export" })).rejects.toBeInstanceOf(BitbucketFailed);
    expect(pullPutFailures).toBe(0);

    // A file that appears on a branch read without one is a moved file.
    branches.set("corbits-triage/policy", { commit: branches.get("corbits-triage/policy")!.commit });
    appearsBeforePut = "rules: []\n";
    await expect(proposePolicy(bb, REPO, "main", { ...change, text: "rules: [] # new\n", body: "new", append: true, readSha: null })).rejects.toBeInstanceOf(PolicyFileMoved);

    // An export over a description holding batch sections keeps them and adds its own, so the next batch adds none back.
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Kept }\n", body: "kept", append: true });
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Exported }\n", body: "exported" });
    expect(pulls[0]!.description).toContain("\nkept\n");
    expect(pulls[0]!.description).toEndWith("\nexported");
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: After }\n", body: "after", append: true });
    expect(pulls[0]!.description.split("\nkept\n")).toHaveLength(2);
    expect(pulls[0]!.description.split("\nlost\n")).toHaveLength(2);

    // A lost section older than the newest hundred commits is found on a later page.
    const older = Array.from({ length: 101 }, (_, at) => ({ branch: "corbits-triage/policy", id: `x${at + 1}`, message: `${change.title}\n\nolder ${at + 1}` }));
    log.unshift(...older);
    pulls[0]!.description = bodyWith(pulls[0]!.description, older.slice(1).map((row) => ({ commit: row.id, text: row.message.slice(change.title.length + 2) })));
    await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\nlabels: { pass: Paged }\n", body: "paged", append: true });
    expect(pulls[0]!.description).toContain("(corbits-triage added x1)\n\nolder 1\n");

    // Merged and left behind, the branch starts over from main for the next pull request.
    pulls[0]!.open = false;
    branches.set("main", { text: "rules: []\nlabels: { pass: Ready }\n", commit: "c9" });
    expect(await proposePolicy(bb, REPO, "main", { ...change, text: "rules: []\n", body: "third" })).toMatchObject({ number: 2 });
    expect(edits.at(-1)).toEqual({ content: "rules: []\n", message: change.title, branch: "corbits-triage/policy", sourceBranch: "main", sourceCommitId: "c9" });

    // Another caller opening it between the check and the create is answered with theirs.
    pulls[1]!.open = false;
    raced = { id: 3, version: 0, title: change.title, description: "theirs", fromRef: { id: "refs/heads/corbits-triage/policy" }, toRef: { id: "refs/heads/main" }, open: true };
    expect(await proposePolicy(bb, REPO, "main", { ...change, body: "fourth" })).toMatchObject({ number: 3 });
    expect(pulls.filter((pull) => pull.open)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});
