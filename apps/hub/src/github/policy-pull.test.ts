import { expect, test } from "bun:test";
import { bodyWith, DescriptionNotUpdated, missingSections, PolicyFileMoved, proposePolicy, PULL_BODY_MAX } from "./policy-pull.js";

const TITLE = "chore: update the Corbits Triage rules";

test("a body near the limit drops its oldest sections and keeps the one it was opened with", () => {
  const opened = "Updates the rules in `.corbits-triage.yml`:\n\n- Turns on `docs`.";
  let body: string = opened;
  for (let batch = 0; batch < 40; batch += 1) body = bodyWith(body, [{ commit: `c${batch}`, text: `batch ${batch}\n${"x".repeat(2_000)}` }]);
  expect(body.length).toBeLessThanOrEqual(PULL_BODY_MAX);
  expect(body).toStartWith(`${opened}\n\n`);
  expect(body).toEndWith(`batch 39\n${"x".repeat(2_000)}`);
  expect(body).not.toContain("batch 0\n");
  expect(body).toContain("batch 20\n");
  // A section cut for room keeps its marker, so its commit is not added back by the next batch.
  expect(body).toContain("(corbits-triage added c0)");
  expect(missingSections(body, [{ commit: "c0", message: `${TITLE}\n\nbatch 0` }], TITLE)).toEqual([]);
});

test("the cap holds when the body has CRLF endings, and a section too long for it ends truncated", () => {
  const opened = "Opened with this.";
  const crlf = bodyWith(opened, [{ commit: "c0", text: "batch 0" }]).replace(/\n/g, "\r\n");
  const capped = bodyWith(`${crlf}\r\n`, [{ commit: "c1", text: `batch 1\n${"x".repeat(PULL_BODY_MAX)}` }]);
  expect(capped.length).toBeLessThanOrEqual(PULL_BODY_MAX);
  expect(capped).toStartWith(`${opened}\n\n`);
  expect(capped).not.toContain("batch 0");
  expect(capped).toContain("batch 1\n");
  expect(capped).toEndWith("\n(truncated)");
  const full = bodyWith("x".repeat(PULL_BODY_MAX), [{ commit: "c2", text: "batch 2" }]);
  expect(full.length).toBeLessThanOrEqual(PULL_BODY_MAX);
  expect(full).toContain("(corbits-triage added c2)");
  expect(full).not.toContain("batch 2");
});

test("markers past the cap give way to one line, and the commits it leaves out are not added back", () => {
  function sha(at: number): string {
    return at.toString(16).padStart(40, "0");
  }
  const body = ["Opened.", ...Array.from({ length: 900 }, (_, at) => `[//]: # (corbits-triage added ${sha(at)})`)].join("\n\n");
  const capped = bodyWith(body, [{ commit: sha(900), text: "newest" }]);
  expect(capped.length).toBeLessThanOrEqual(PULL_BODY_MAX);
  expect(capped).toStartWith("Opened.\n\n");
  expect(capped.split("Earlier batches are left out to fit the description.")).toHaveLength(2);
  expect(capped).not.toContain(`added ${sha(0)})`);
  expect(capped).toEndWith("newest");
  const commits = Array.from({ length: 902 }, (_, at) => ({ commit: sha(at), message: `${TITLE}\n\nbatch ${at}` }));
  expect(missingSections(capped, commits, TITLE)).toEqual([{ commit: sha(901), text: "batch 901" }]);
  expect(bodyWith(capped, [{ commit: sha(901), text: "next" }]).length).toBeLessThanOrEqual(PULL_BODY_MAX);
});

test("only the batch commits the description does not name yet get a section", () => {
  const body = bodyWith("Opened.", [{ commit: "c1", text: "first" }]);
  const commits = [
    { commit: "c1", message: `${TITLE}\n\nfirst` },
    { commit: "c2", message: "chore: add a Corbits Triage policy" },
    { commit: "c3", message: `${TITLE}\n\nthird` },
  ];
  expect(missingSections(body, commits, TITLE)).toEqual([{ commit: "c3", text: "third" }]);
});

const CHANGE = { path: ".corbits-triage.yml", text: "rules: []\n", title: TITLE, body: "- Turns on `docs`.", append: true };

/** An open policy pull request on `acme/w`; `put` answers the commit, `pages` the commit listing, and `edits` holds each description written. */
function fakeGithub(put: () => Response, pages: Array<Array<{ sha: string; commit: { message: string } }>>, edits: string[], opened: string | null = null) {
  return async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const pull = { number: 1, html_url: "https://github.com/acme/w/pull/1", head: { sha: "head" }, body: edits.at(-1) ?? opened };
    if (method === "GET" && path === "/repos/acme/w") return Response.json({ default_branch: "main" });
    if (method === "GET" && path.startsWith("/repos/acme/w/pulls?")) return Response.json([pull]);
    if (method === "GET" && path.startsWith("/repos/acme/w/contents/")) return new Response(null, { status: 404 });
    if (method === "PUT") return put();
    if (method === "GET" && path.startsWith("/repos/acme/w/pulls/1/commits")) {
      const page = Number(new URL(path, "https://github.invalid").searchParams.get("page") ?? "1");
      const next = page < pages.length ? { link: `<https://api.github.com/repos/acme/w/pulls/1/commits?per_page=100&page=${page + 1}>; rel="next"` } : undefined;
      return Response.json(pages[page - 1], { headers: next });
    }
    if (method === "GET" && path === "/repos/acme/w/pulls/1") return Response.json(pull);
    if (method === "PATCH" && path === "/repos/acme/w/pulls/1") {
      const { body } = JSON.parse(String(init!.body)) as { body: string };
      edits.push(body);
      return Response.json({ number: 1, html_url: "https://github.com/acme/w/pull/1", head: { sha: "head" }, body });
    }
    return new Response(null, { status: 404 });
  };
}

test("a file that appears on the branch between the read and a write naming no sha is a moved file; another 422 is GitHub's refusal", async () => {
  const appeared = fakeGithub(() => Response.json({ message: "Invalid request.\n\n\"sha\" wasn't supplied." }, { status: 422 }), [[]], []);
  await expect(proposePolicy(appeared, "acme/w", { ...CHANGE, readSha: null })).rejects.toBeInstanceOf(PolicyFileMoved);
  const protectedBranch = fakeGithub(() => Response.json({ message: "Repository rule violations found" }, { status: 422 }), [[]], []);
  const refused = proposePolicy(protectedBranch, "acme/w", { ...CHANGE, readSha: null });
  await expect(refused).rejects.not.toBeInstanceOf(PolicyFileMoved);
  await expect(refused).rejects.toThrow("-> 422 Repository rule violations found");
});

test("a lost section past the first hundred commits is found and added", async () => {
  const commits = Array.from({ length: 101 }, (_, at) => ({ sha: `c${at + 1}`, commit: { message: `${TITLE}\n\nbatch ${at + 1}` } }));
  const edits: string[] = [];
  const gh = fakeGithub(() => Response.json({ commit: { sha: "c102" } }, { status: 201 }), [commits.slice(0, 100), commits.slice(100)], edits);
  await proposePolicy(gh, "acme/w", { ...CHANGE, body: "batch 102" });
  expect(edits).toHaveLength(1);
  expect(edits[0]).toContain("(corbits-triage added c101)\n\nbatch 101");
  expect(edits[0]!.endsWith("(corbits-triage added c102)\n\nbatch 102")).toBe(true);
});

test("an export over a description holding batch sections keeps them and adds its own, so the next batch adds none back", async () => {
  const pages = [[{ sha: "c1", commit: { message: `${TITLE}\n\nbatch 1` } }]];
  const edits: string[] = [];
  let written = 1;
  function put(): Response {
    written += 1;
    return Response.json({ commit: { sha: `c${written}` } }, { status: 201 });
  }
  const gh = fakeGithub(put, pages, edits, bodyWith("", [{ commit: "c1", text: "batch 1" }]));
  await proposePolicy(gh, "acme/w", { ...CHANGE, title: "chore: keep the rules in the file", body: "exported", append: false });
  expect(edits.at(-1)).toContain("(corbits-triage added c1)\n\nbatch 1");
  expect(edits.at(-1)!.endsWith("(corbits-triage added c2)\n\nexported")).toBe(true);
  await proposePolicy(gh, "acme/w", { ...CHANGE, body: "batch 3" });
  expect(edits.at(-1)!.split("(corbits-triage added c1)")).toHaveLength(2);
  expect(edits.at(-1)!.endsWith("(corbits-triage added c3)\n\nbatch 3")).toBe(true);
});

test("a description edit GitHub refuses for good is its refusal at once, not retried", async () => {
  let patches = 0;
  const gh = fakeGithub(() => Response.json({ commit: { sha: "c1" } }, { status: 201 }), [[]], []);
  async function refusing(path: string, init?: RequestInit): Promise<Response> {
    if (init?.method !== "PATCH") return gh(path, init);
    patches += 1;
    return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
  }
  const refused = proposePolicy(refusing, "acme/w", CHANGE);
  await expect(refused).rejects.not.toBeInstanceOf(DescriptionNotUpdated);
  await expect(refused).rejects.toThrow("-> 403 Resource not accessible by integration");
  expect(patches).toBe(1);
});
