// Stands in for api.github.com in end-to-end runs. Any bearer token is accepted:
// the hub sends an App JWT to /app/* and an installation token elsewhere.
const REPO = "acme/widgets";
const INSTALLATION_ID = 100;
const SHA_PREFIX = "a".repeat(30);
const NOW = "2026-01-01T00:00:00Z";
const user = { login: "octocat" };

type Check = { name: string; status: string; conclusion: string | null };
type Seed = {
  number: number;
  title: string;
  body: string;
  draft?: boolean;
  mergeable?: boolean;
  checks: Check[];
  files: Array<{ filename: string; patch: string }>;
};

export type Call = { method: string; path: string; body: unknown };

function file(filename: string) {
  return { filename, patch: `@@ -1 +1 @@\n-old\n+new ${filename}` };
}

const passing: Check[] = [{ name: "ci", status: "completed", conclusion: "success" }];
const failing: Check[] = [{ name: "ci", status: "completed", conclusion: "failure" }];

const seeds: Seed[] = [
  { number: 1, title: "fix: handle empty cart", body: "Fixes #50", checks: passing, files: [file("src/cart.ts"), file("src/cart.test.ts")] },
  { number: 2, title: "wip: new checkout", body: "Fixes #50", draft: true, checks: passing, files: [file("src/checkout.ts")] },
  { number: 3, title: "fix: retry payments", body: "Fixes #50", checks: failing, files: [file("src/pay.ts"), file("src/pay.test.ts")] },
  { number: 4, title: "chore: patch vendored lib", body: "Fixes #50", checks: passing, files: [file("vendor/x.js")] },
  { number: 5, title: "feat: add banner", body: "Adds a banner to the home page.", checks: passing, files: [file("src/banner.ts"), file("src/banner.test.ts")] },
  { number: 6, title: "refactor: rename everything", body: "Fixes #50", checks: passing, files: Array.from({ length: 35 }, (_, i) => file(`src/gen/file${i}.ts`)) },
  { number: 7, title: "fix: stale lockfile", body: "Fixes #50", mergeable: false, checks: passing, files: [file("src/lock.ts"), file("src/lock.test.ts")] },
];

function sha(n: number) {
  return `${SHA_PREFIX}${String(n).padStart(10, "0")}`;
}

function pull(seed: Seed, state: string) {
  const mergeable = seed.mergeable ?? true;
  return {
    number: seed.number,
    title: seed.title,
    body: seed.body,
    state,
    draft: seed.draft ?? false,
    user,
    head: { sha: sha(seed.number) },
    base: { ref: "main" },
    mergeable,
    mergeable_state: mergeable ? "clean" : "dirty",
    requested_reviewers: [],
    requested_teams: [],
    additions: seed.files.length,
    deletions: seed.files.length,
    changed_files: seed.files.length,
    labels: [],
    updated_at: NOW,
  };
}

function page(req: Request, rows: unknown[]) {
  const url = new URL(req.url);
  const perPage = Number(url.searchParams.get("per_page") ?? 30);
  const at = Number(url.searchParams.get("page") ?? 1);
  return Response.json(rows.slice((at - 1) * perPage, at * perPage));
}

function notFound() {
  return Response.json({ message: "Not Found" }, { status: 404 });
}

export function startFakeGithub({ port }: { port: number }) {
  const calls: Call[] = [];
  const states = new Map(seeds.map((s) => [s.number, "open"]));
  const comments = new Map<number, Array<{ id: number; body: string; user: typeof user; created_at: string }>>();
  let nextId = 1000;

  function pullState(seed: Seed) {
    return states.get(seed.number) ?? "open";
  }

  async function handlePull(req: Request, seed: Seed, rest: string | undefined, body: any): Promise<Response> {
    const method = req.method;
    if (method === "GET" && rest === undefined) return Response.json(pull(seed, pullState(seed)));
    if (method === "PATCH" && rest === undefined) {
      if (body?.state) states.set(seed.number, body.state);
      return Response.json(pull(seed, pullState(seed)));
    }
    if (method === "GET" && rest === "reviews") return page(req, []);
    if (method === "POST" && rest === "reviews") return Response.json({ id: nextId++, state: body.event === "COMMENT" ? "COMMENTED" : body.event });
    if (method === "PUT" && rest === "merge") return Response.json({ merged: true, sha: sha(seed.number) });
    if (method === "GET" && rest === "commits") {
      return page(req, [{ sha: sha(seed.number), commit: { message: seed.title, author: { name: user.login, date: NOW }, committer: { date: NOW } }, author: user }]);
    }
    if (method === "GET" && rest === "files") {
      return page(req, seed.files.map((f) => ({ ...f, status: "modified", additions: 1, deletions: 1 })));
    }
    return notFound();
  }

  function handleIssues(req: Request, parts: string[], body: any): Response {
    const method = req.method;
    if (parts[1] === "comments" && method === "PATCH") {
      for (const list of comments.values()) {
        const found = list.find((c) => c.id === Number(parts[2]));
        if (found) {
          found.body = body.body;
          return Response.json(found);
        }
      }
      return notFound();
    }
    const n = Number(parts[1]);
    if (parts[2] === "comments" && method === "GET") return page(req, comments.get(n) ?? []);
    if (parts[2] === "comments" && method === "POST") {
      const created = { id: nextId++, body: body.body, user, created_at: NOW };
      comments.set(n, [...(comments.get(n) ?? []), created]);
      return Response.json(created, { status: 201 });
    }
    if (parts[2] === "labels" && method === "PUT") return Response.json((body.labels as string[]).map((name) => ({ name })));
    if (parts.length === 2 && method === "GET") {
      if (n === 50) return Response.json({ number: 50, title: "Cart crashes when empty", body: "Open an empty cart and the page crashes.", state: "open", user, labels: [], created_at: NOW, updated_at: NOW });
      const seed = seeds.find((s) => s.number === n);
      if (seed) return Response.json({ number: n, title: seed.title, body: seed.body, state: pullState(seed), user, labels: [], pull_request: {} });
    }
    return notFound();
  }

  async function handleRepo(req: Request, parts: string[], url: URL, body: any): Promise<Response> {
    if (parts[0] === "pulls" && parts.length === 1 && req.method === "GET") {
      const wanted = url.searchParams.get("state") ?? "open";
      return page(req, seeds.filter((s) => pullState(s) === wanted).map((s) => pull(s, wanted)));
    }
    if (parts[0] === "pulls") {
      const seed = seeds.find((s) => s.number === Number(parts[1]));
      return seed ? handlePull(req, seed, parts[2], body) : notFound();
    }
    if (parts[0] === "commits" && parts[2] === "check-runs" && req.method === "GET") {
      const seed = seeds.find((s) => sha(s.number) === parts[1]);
      const checks = seed?.checks ?? [];
      return Response.json({ total_count: checks.length, check_runs: checks });
    }
    if (parts[0] === "issues") return handleIssues(req, parts, body);
    return notFound();
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const text = method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method, path, body });

    if (!req.headers.get("authorization")?.startsWith("Bearer ")) {
      return Response.json({ message: "Requires authentication" }, { status: 401 });
    }

    if (method === "GET" && path === "/app") return Response.json({ slug: "corbits-triage-fake" });
    if (method === "GET" && path === "/app/installations") {
      return page(req, [{
        id: INSTALLATION_ID,
        account: { login: "acme" },
        html_url: `https://github.com/organizations/acme/settings/installations/${INSTALLATION_ID}`,
        repository_selection: "selected",
        suspended_at: null,
      }]);
    }
    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return Response.json({ token: "ghs_fake_installation_token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    }
    if (method === "GET" && path === "/installation/repositories") {
      return Response.json({ total_count: 1, repositories: [{ full_name: REPO }] });
    }
    if (method === "GET" && path === "/orgs/acme/members") return page(req, [user]);
    if (method === "GET" && path === `/repos/${REPO}`) return Response.json({ full_name: REPO, owner: { login: "acme", type: "Organization" } });

    const prefix = `/repos/${REPO}/`;
    if (!path.startsWith(prefix)) return notFound();
    return handleRepo(req, path.slice(prefix.length).split("/"), url, body);
  }

  const server = Bun.serve({ port, fetch: handle });

  return {
    url: `http://localhost:${server.port}`,
    calls: (): Call[] => [...calls],
    mirrored: (): Call[] => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/access_tokens")),
    stop: () => server.stop(true),
  };
}
