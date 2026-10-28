// GitHub as the hub and the workflows' sidecars reach it: one App installed on one account, its repositories, their
// policy files and open pull requests. Writes change what later reads answer and are kept in order for the test.
import { POLICY_FILE_PATH } from "@corbits/triage-contracts";

export const OWNER = "acme";
export const INSTALLATION = 1;
const BOT = { login: "corbits[bot]", type: "Bot" };
const TOKEN = "installation-token";
/** What the hub mints for code review, asked with the permissions it narrows to. */
const READ_TOKEN = "read-token";

export type File = { filename: string; status: string; additions: number; deletions: number; patch: string };
export type CheckRun = { name: string; status: "queued" | "in_progress" | "completed"; conclusion: "success" | "failure" | null };
export type Pull = {
  number: number;
  title: string;
  body: string;
  author: string;
  head: string;
  files: File[];
  commits: string[];
  labels: string[];
  comments: { id: number; user: typeof BOT; body: string }[];
};
export type Write = { method: string; path: string; body: unknown };

/** A null `policy` is a repository with no policy file. */
type Repo = { name: string; policy: string | null; pulls: Map<number, Pull>; checks: Map<string, CheckRun[]> };

export function fakeGithub() {
  const repos = new Map<string, Repo>();
  const writes: Write[] = [];
  const misses: string[] = [];
  const requests: string[] = [];
  const held = new Map<string, Promise<void>>();
  let ids = 0;

  function pullJson(repo: Repo, pull: Pull) {
    return {
      number: pull.number, title: pull.title, body: pull.body, body_html: `<p>${pull.body}</p>`, state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean",
      user: { login: pull.author, type: "User" }, author_association: "CONTRIBUTOR", head: { sha: pull.head, ref: `pr-${pull.number}`, repo: { id: 1, full_name: repo.name } }, base: { ref: "main", sha: "0".repeat(40), repo: { id: 1, full_name: repo.name } },
      additions: pull.files.reduce((sum, file) => sum + file.additions, 0), deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
      changed_files: pull.files.length, labels: pull.labels.map((name) => ({ name })), requested_reviewers: [], requested_teams: [], assignees: [],
    };
  }

  async function readRoute(repo: Repo, rest: string, url: URL): Promise<Response | undefined> {
    if (rest === "") return Response.json({ full_name: repo.name, default_branch: "main", private: false, owner: { login: OWNER, type: "Organization" } });
    if (rest === "/installation") return Response.json({ id: INSTALLATION });
    if (rest === `/contents/${POLICY_FILE_PATH}` && repo.policy !== null) return Response.json({ type: "file", sha: "policy", encoding: "base64", content: Buffer.from(repo.policy).toString("base64"), html_url: `https://github.com/${repo.name}/blob/main/${POLICY_FILE_PATH}` });
    if (rest.startsWith("/contents")) return new Response(null, { status: 404 });
    if (rest === "/pulls") return Response.json([...repo.pulls.values()].map((pull) => pullJson(repo, pull)));
    const pulled = /^\/(pulls|issues)\/(\d+)(\/.*)?$/.exec(rest);
    if (pulled) {
      const pull = repo.pulls.get(Number(pulled[2]));
      if (!pull) return new Response(null, { status: 404 });
      const tail = pulled[3] ?? "";
      if (tail === "") return Response.json(pullJson(repo, pull));
      if (tail === "/files") {
        await held.get(`${repo.name}#${pull.number}`);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        return Response.json(pull.files.slice((page - 1) * perPage, page * perPage));
      }
      if (tail === "/commits") return Response.json(pull.commits.map((message, index) => ({ sha: index === pull.commits.length - 1 ? pull.head : `c${index}`.padEnd(40, "0"), commit: { message } })));
      if (tail === "/reviews") return Response.json([]);
      if (tail === "/comments") return Response.json(pulled[1] === "issues" ? pull.comments : []);
      if (tail === "/labels") return Response.json(pull.labels.map((name) => ({ name })));
      if (tail === "/requested_reviewers") return Response.json({ users: [], teams: [] });
      if (tail === "/timeline" || tail === "/events") return Response.json([]);
      return undefined;
    }
    const commit = /^\/commits\/([0-9a-f]+)\/(check-runs|status|check-suites)$/.exec(rest);
    const runs = commit && repo.checks.get(commit[1]!);
    if (commit && runs) {
      if (commit[2] === "check-runs") return Response.json({ total_count: runs.length, check_runs: runs.map((run, index) => ({ id: index + 1, head_sha: commit[1], ...run })) });
      if (commit[2] === "status") return Response.json({ state: "success", statuses: [], total_count: 0 });
      return Response.json({ total_count: 0, check_suites: [] });
    }
    if (rest.startsWith("/git/trees/")) return Response.json({ sha: "tree", tree: [], truncated: false });
    if (rest.startsWith("/collaborators/")) return Response.json({ permission: "read", role_name: "read" });
    if (rest === "/labels" || rest.startsWith("/labels?")) return Response.json([]);
    return undefined;
  }

  /** The writes triage makes; any other is a miss, so a new write shows up as a failed scenario. */
  function writeRoute(repo: Repo, rest: string, method: string, body: Record<string, unknown>): Response | undefined {
    const issue = /^\/(issues|pulls)\/(\d+)(\/.*)?$/.exec(rest);
    const pull = issue ? repo.pulls.get(Number(issue[2])) : undefined;
    const tail = issue?.[3];
    if (pull && tail === "/labels" && method === "POST") {
      for (const name of body["labels"] as string[]) if (!pull.labels.includes(name)) pull.labels.push(name);
      return Response.json(pull.labels.map((name) => ({ name })));
    }
    if (pull && tail?.startsWith("/labels/") && method === "DELETE") {
      const name = decodeURIComponent(tail.slice("/labels/".length));
      pull.labels = pull.labels.filter((label) => label !== name);
      return Response.json(pull.labels.map((name) => ({ name })));
    }
    if (pull && tail === "/comments" && method === "POST") {
      ids += 1;
      pull.comments.push({ id: ids, user: BOT, body: String(body["body"]) });
      return Response.json(pull.comments.at(-1), { status: 201 });
    }
    if (pull && tail === "/assignees" && method === "POST") return Response.json(pullJson(repo, pull), { status: 201 });
    if (pull && tail === "/requested_reviewers" && method === "POST") return Response.json({ ...pullJson(repo, pull), requested_reviewers: (body["reviewers"] as string[]).map((login) => ({ login })) }, { status: 201 });
    const edited = /^\/issues\/comments\/(\d+)$/.exec(rest);
    const comment = edited && method === "PATCH" ? [...repo.pulls.values()].flatMap((each) => each.comments).find((row) => row.id === Number(edited[1])) : undefined;
    if (comment) {
      comment.body = String(body["body"]);
      return Response.json(comment);
    }
    return undefined;
  }

  function mint(asked: string): Response {
    const expires_at = new Date(Date.now() + 3_600_000).toISOString();
    if (asked === "") return Response.json({ token: TOKEN, expires_at }, { status: 201 });
    const { permissions } = JSON.parse(asked) as { permissions: Record<string, string> };
    return Response.json({ token: READ_TOKEN, expires_at, permissions: { ...permissions, metadata: "read" } }, { status: 201 });
  }

  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    requests.push(`${req.method} ${pathname}${url.search}`);
    if (pathname === "/app") return Response.json({ id: 1, slug: "corbits", name: "Corbits" });
    if (pathname === "/app/installations") return Response.json([{ id: INSTALLATION, account: { login: OWNER }, html_url: "https://github.com/settings/installations/1", repository_selection: "selected", suspended_at: null }]);
    if (pathname === `/app/installations/${INSTALLATION}/access_tokens`) return mint(await req.text());
    if (pathname === "/installation/repositories") return Response.json({ total_count: repos.size, repositories: [...repos.keys()].map((name) => ({ full_name: name })) });
    const named = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(pathname);
    const repo = named ? repos.get(named[1]!) : undefined;
    if (repo && req.method === "GET") {
      const answer = await readRoute(repo, named![2]!, url);
      if (answer) return answer;
    }
    if (repo && req.method !== "GET") {
      const text = await req.text();
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const answer = writeRoute(repo, named![2]!, req.method, body);
      if (answer) {
        writes.push({ method: req.method, path: pathname, body });
        return answer;
      }
    }
    misses.push(`${req.method} ${pathname}`);
    return new Response(null, { status: 404 });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    writes,
    misses,
    requests,
    addRepo(name: string, policy: string | null): void {
      repos.set(name, { name, policy, pulls: new Map(), checks: new Map() });
    },
    /** The policy file as a merge to the default branch leaves it. */
    setPolicy(name: string, policy: string): void {
      repos.get(name)!.policy = policy;
    },
    /** Shows `pull` at its head, which has no check runs unless the test set some. */
    open(repo: string, pull: Pull): void {
      const shown = repos.get(repo)!;
      shown.pulls.set(pull.number, pull);
      if (!shown.checks.has(pull.head)) shown.checks.set(pull.head, []);
    },
    pull(repo: string, number: number): Pull {
      return repos.get(repo)!.pulls.get(number)!;
    },
    /** Holds reads of the pull request's files, and so its manager's pass, until the returned release is called. */
    hold(repo: string, number: number): () => void {
      let release = () => {};
      held.set(`${repo}#${number}`, new Promise(function wait(resolve) { release = resolve; }));
      return function released() {
        held.delete(`${repo}#${number}`);
        release();
      };
    },
    setChecks(repo: string, head: string, runs: CheckRun[]): void {
      repos.get(repo)!.checks.set(head, runs);
    },
    writesTo(repo: string, number: number): Write[] {
      return writes.filter((write) => write.path.startsWith(`/repos/${repo}/issues/${number}/`) || write.path.startsWith(`/repos/${repo}/pulls/${number}/`));
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export type FakeGithub = ReturnType<typeof fakeGithub>;
