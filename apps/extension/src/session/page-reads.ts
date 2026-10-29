/**
 * The GitHub REST reads local triage makes, answered from github.com's own pages and route data in the content script,
 * so they go out as the person signed in on the page and spend none of api.github.com's hourly limit. Each answer has
 * the API's shape for the fields triage reads; a path not listed here is not answered and goes to the API.
 */

const JSON_HEADERS = { accept: "application/json", "x-requested-with": "XMLHttpRequest", "github-verified-fetch": "true" };
// The commit's checks page has no route data, only its server-rendered page.
const HTML_HEADERS = { accept: "text/html" };

const PULL = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)$/;
const REVIEWS = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/reviews$/;
const COMMITS = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/commits$/;
const ISSUE_COMMENTS = /^\/repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/comments$/;
const OPEN_PULLS = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls$/;
const FOLDER = /^\/repos\/([\w.-]+\/[\w.-]+)\/contents(?:\/(.+))?$/;
const CHECK_RUNS = /^\/repos\/([\w.-]+\/[\w.-]+)\/commits\/([0-9a-f]{40})\/check-runs$/;

/** A check run's state as the API gives it, by what the checks page's icon says; the first match wins. */
const RUN_STATES: Array<[RegExp, { status: string; conclusion: string | null }]> = [
  [/succeeded|passed/i, { status: "completed", conclusion: "success" }],
  [/skipped/i, { status: "completed", conclusion: "skipped" }],
  [/cancelled|canceled/i, { status: "completed", conclusion: "cancelled" }],
  [/neutral/i, { status: "completed", conclusion: "neutral" }],
  [/requires action/i, { status: "completed", conclusion: "action_required" }],
  [/timed out/i, { status: "completed", conclusion: "timed_out" }],
  [/stale/i, { status: "completed", conclusion: "stale" }],
  [/startup|start up/i, { status: "completed", conclusion: "startup_failure" }],
  [/failed/i, { status: "completed", conclusion: "failure" }],
  [/in progress/i, { status: "in_progress", conclusion: null }],
  [/queued|waiting|pending|requested/i, { status: "queued", conclusion: null }],
];

// GitHub's pull request list shows this many to a page.
const DASHBOARD_PAGE = 25;
// A pull request's timeline route gives only its first this many items.
const TIMELINE_ITEMS = 25;

/** The page writes times with the viewer's offset; the API writes them in UTC, and triage compares them as text. */
function utc(time: string): string {
  return new Date(time).toISOString().replace(".000Z", "Z");
}

function loginOf(user: { slug?: string | null; displayLogin: string }): string {
  return user.slug ? `${user.slug}[bot]` : user.displayLogin;
}

/** One triage run's page reads, each URL fetched once however many API paths need it. */
export type PageReads = { answer(path: string): Promise<string | null> };

export function pageReads(): PageReads {
  const fetched = new Map<string, Promise<string>>();

  async function get(url: string, headers: Record<string, string>): Promise<string> {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`github.com ${url} -> ${res.status}`);
    return res.text();
  }

  function read(url: string, headers: Record<string, string> = JSON_HEADERS): Promise<string> {
    let pending = fetched.get(url);
    if (!pending) {
      pending = get(url, headers);
      fetched.set(url, pending);
    }
    return pending;
  }

  async function json(url: string): Promise<any> {
    return JSON.parse(await read(url));
  }

  /** A route's server-rendered partial, as a document to query. */
  async function partial(url: string): Promise<Document> {
    const payload = (await json(url)).payload as Record<string, { value?: unknown }> | undefined;
    const html = Object.values(payload ?? {})[0]?.value;
    if (typeof html !== "string") throw new Error(`github.com ${url} has no partial`);
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function sidebar(repo: string, number: number) {
    const doc = await partial(`/${repo}/pull/${number}/partials/sidebar`);
    const awaiting = [...doc.querySelectorAll('[id^="awaiting-review-"]')].map((node) => node.id.slice("awaiting-review-".length));
    return {
      labels: [...doc.querySelectorAll(".js-issue-labels [data-name]")].map((node) => node.getAttribute("data-name")!),
      assignees: [...doc.querySelectorAll(".js-issue-assignees [data-assignee-name]")].map((node) => node.getAttribute("data-assignee-name")!),
      users: awaiting.filter((login) => !login.includes("/")),
      teams: awaiting.filter((login) => login.includes("/")).map((team) => team.split("/").at(-1)!),
      // Each reviewer's latest review links to the commit it was left on.
      reviewedAt: new Map([...doc.querySelectorAll<HTMLAnchorElement>('a[id^="review-status-"]')].map((link) => [link.id.slice("review-status-".length), link.getAttribute("href")?.split("/").at(-1) ?? ""])),
    };
  }

  /** The description as written, in markdown, and GitHub's rendering of it, as the API's full media type gives them. */
  async function description(repo: string, number: number): Promise<{ body: string; bodyHtml: string }> {
    const { body, bodyHtml } = await json(`/${repo}/pull/${number}/page_data/description`) as { body?: unknown; bodyHtml?: unknown };
    if (typeof body !== "string" || typeof bodyHtml !== "string") throw new Error(`github.com has no description for ${repo}#${number}`);
    return { body, bodyHtml };
  }

  async function association(repo: string, number: number): Promise<string> {
    const found = (await json(`/${repo}/pulls?q=${encodeURIComponent(`is:pr ${number}`)}`)).payload?.repoPullsDashboardContentRoute?.results as Array<{ number: number; author?: { association?: string; identity?: string } }> | undefined;
    const row = found?.find((each) => each.number === number);
    if (!row) throw new Error(`github.com's pull request search has not listed ${repo}#${number} yet`);
    const value = row.author?.association;
    if (value) return value.replace("REPO_PULL_REQUEST_AUTHOR_ASSOCIATION_", "");
    // The search gives a bot none; the API's CONTRIBUTOR or NONE for a bot triage the same, as an outside bot.
    if (row.author?.identity === "REPO_PULL_REQUEST_AUTHOR_IDENTITY_BOT") return "NONE";
    throw new Error(`github.com's pull request search gives no association for ${repo}#${number}'s author`);
  }

  async function mergeable(repo: string, base: string, headOwner: string, headBranch: string): Promise<boolean | null> {
    const branch = encodeURIComponent(headBranch);
    const head = headOwner && headOwner !== repo.split("/")[0] ? `${headOwner}:${branch}` : branch;
    const { state } = await json(`/${repo}/branches/pre_mergeable/${encodeURIComponent(base)}...${head}`) as { state?: string };
    if (state === "clean") return true;
    if (state === "dirty") return false;
    return null;
  }

  async function pull(repo: string, number: number) {
    const base = `/${repo}/pull/${number}`;
    const [{ pullRequest: pr }, side, text, assoc, stat, counts] = await Promise.all([
      json(`${base}/page_data/header`),
      sidebar(repo, number),
      description(repo, number),
      association(repo, number),
      json(`${base}/page_data/diffstat`),
      json(`${base}/page_data/tab_counts`),
    ]);
    const open = pr.state === "OPEN" || pr.state === "DRAFT";
    const login = pr.author.slug ? `${pr.author.slug}[bot]` : pr.author.login;
    return {
      number,
      title: pr.title,
      body: text.body,
      body_html: text.bodyHtml,
      state: open ? "open" : "closed",
      merged: pr.state === "MERGED",
      draft: pr.state === "DRAFT",
      user: { login, type: pr.author.slug ? "Bot" : "User" },
      author_association: assoc,
      head: { sha: pr.headSha, ref: pr.headBranch },
      base: { ref: pr.baseBranch },
      mergeable: open ? await mergeable(repo, pr.baseBranch, pr.headRepositoryOwnerLogin, pr.headBranch) : null,
      requested_reviewers: side.users.map((each) => ({ login: each })),
      requested_teams: side.teams.map((slug) => ({ slug })),
      assignees: side.assignees.map((each) => ({ login: each })),
      additions: stat.diffstat.linesAdded,
      deletions: stat.diffstat.linesDeleted,
      changed_files: counts.filesChangedCount,
      labels: side.labels.map((name) => ({ name })),
    };
  }

  /** The pull request's timeline, refused when cut at its first items, since what is past the cut cannot be told. */
  async function timelineItems(repo: string, number: number): Promise<any[]> {
    const items = (await json(`/${repo}/pull/${number}/page_data/timeline`)).items as any[];
    if (items.length >= TIMELINE_ITEMS) throw new Error(`github.com's timeline shows only the first ${TIMELINE_ITEMS} items of ${repo}#${number}`);
    return items;
  }

  async function reviews(repo: string, number: number) {
    const rows = (await timelineItems(repo, number)).filter((item) => item.type === "TIMELINE_ITEM_TYPE_PULL_REQUEST_REVIEW");
    const side = await sidebar(repo, number);
    const latest = new Map<string, number>();
    rows.forEach((item, index) => latest.set(item.user.slug ?? item.user.displayLogin, index));
    // The sidebar and timeline are separate reads, so a review left between them is on one and not the other.
    const missing = [...side.reviewedAt.keys()].filter((login) => !latest.has(login));
    if (missing.length) throw new Error(`github.com's timeline does not show ${missing.join(", ")}'s review of ${repo}#${number}`);
    return rows.map(function review(item, index) {
      const key = item.user.slug ?? item.user.displayLogin;
      const commit = latest.get(key) === index ? side.reviewedAt.get(key) : undefined;
      // Without its commit, a reviewer's latest review would count as left on the current head.
      if (latest.get(key) === index && !commit) throw new Error(`github.com's sidebar does not say which commit ${key} last reviewed`);
      return {
        user: { login: loginOf(item.user) },
        state: String(item.additionalInfo.pullRequestReview.state).toUpperCase(),
        submitted_at: utc(item.timestamp),
        ...(commit ? { commit_id: commit } : {}),
      };
    });
  }

  /** Only the fields triage reads: who commented and when. */
  async function issueComments(repo: string, number: number) {
    return (await timelineItems(repo, number)).filter((item) => item.type === "TIMELINE_ITEM_TYPE_ISSUE_COMMENT").map((item) => ({
      id: Number(item.additionalInfo.issueComment.commentId),
      user: { login: loginOf(item.user), type: item.user.slug ? "Bot" : "User" },
      body: "",
      created_at: utc(item.timestamp),
    }));
  }

  async function commits(repo: string, number: number) {
    const route = (await json(`/${repo}/pull/${number}/commits`)).payload.pullRequestsCommitsRoute;
    if (route.truncated) throw new Error(`github.com lists only part of ${repo}#${number}'s commits`);
    return (route.commitGroups as any[]).flatMap((group) => group.commits).map((commit: any) => ({
      sha: commit.oid,
      // Only the headline; the session reader puts the whole message in from the pull request's `.patch`.
      commit: { message: commit.shortMessage, committer: { date: commit.committedDate } },
      author: { login: commit.authors[0]?.login ?? "" },
    }));
  }

  /** Every open pull request, or only those into `base` when it is set, or only the newest page of GitHub's list when `newest` asks for no more than one page. */
  async function openPulls(repo: string, newest: boolean, base: string | null) {
    const rows: Array<{ number: number; title: string }> = [];
    const query = base === null ? "is:pr is:open" : `is:pr is:open base:"${base}"`;
    for (let page = 1; ; page++) {
      const route = (await json(`/${repo}/pulls?q=${encodeURIComponent(query)}&page=${page}`)).payload.repoPullsDashboardContentRoute;
      // With nothing open the route leaves out its results and pages.
      if (route.openCount === 0) return rows;
      rows.push(...(route.results as any[]).map((row) => ({ number: row.number, title: row.title, draft: row.displayState === "REPO_PULL_REQUEST_DISPLAY_STATE_DRAFT", head: { sha: row.headSha }, labels: row.labels })));
      if (newest || page >= route.totalPages) return rows;
    }
  }

  /**
   * The commit's check runs, as the API lists them by default: the latest run of each check, legacy commit statuses
   * left out. Its checks page lists exactly those, each under its suite and linked by the run's id.
   */
  async function checkRuns(repo: string, sha: string) {
    const doc = new DOMParser().parseFromString(await read(`/${repo}/commit/${sha}/checks`, HTML_HEADERS), "text/html");
    const runs = [...doc.querySelectorAll<HTMLAnchorElement>(".js-check-suites-sidebar a.SideNav-subItem")].map(function run(link) {
      const name = link.textContent?.trim() ?? "";
      const label = link.closest(".checks-list-item")?.querySelector(".checks-list-item-icon svg")?.getAttribute("aria-label") ?? "";
      const state = RUN_STATES.find(([pattern]) => pattern.test(label))?.[1];
      if (!state) throw new Error(`github.com drew an unknown state "${label}" for check ${name}`);
      const url = new URL(link.getAttribute("href") ?? "", location.origin);
      return { id: Number(url.pathname.split("/").at(-1)), name, ...state, html_url: url.origin + url.pathname };
    });
    // The API lists the newest run first.
    runs.sort((a, b) => b.id - a.id);
    return { total_count: runs.length, check_runs: runs };
  }

  /** A folder's entries on the default branch, as the contents API lists them; none when it is not a folder there. */
  async function folder(repo: string, dir: string) {
    const { oid } = await json(`/${repo}/latest-commit/HEAD`) as { oid: string };
    const { paths } = await json(`/${repo}/tree-list/${oid}`) as { paths: string[] };
    const prefix = dir ? `${dir}/` : "";
    const entries = new Map<string, string>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      entries.set(name!, rest.length ? "dir" : "file");
    }
    return [...entries].map(([name, type]) => ({ name, path: prefix + name, type }));
  }

  function route(path: string): Promise<unknown> | null {
    const { pathname, searchParams } = new URL(path, location.origin);
    let match = PULL.exec(pathname);
    if (match) return pull(match[1]!, Number(match[2]));
    if ((match = REVIEWS.exec(pathname))) return reviews(match[1]!, Number(match[2]));
    if ((match = COMMITS.exec(pathname))) return commits(match[1]!, Number(match[2]));
    if ((match = ISSUE_COMMENTS.exec(pathname))) return issueComments(match[1]!, Number(match[2]));
    // The dashboard filters by neither branch, so a stack's filtered lists are left to the API.
    if ((match = OPEN_PULLS.exec(pathname)) && searchParams.get("state") === "open" && !searchParams.has("head")) return openPulls(match[1]!, Number(searchParams.get("per_page") ?? 30) <= DASHBOARD_PAGE, searchParams.get("base"));
    if ((match = CHECK_RUNS.exec(pathname))) return checkRuns(match[1]!, match[2]!);
    if ((match = FOLDER.exec(pathname)) && !searchParams.has("ref")) return folder(match[1]!, decodeURIComponent(match[2] ?? ""));
    return null;
  }

  /** The API's JSON for `path`, or null when it is not one the page answers. */
  async function answer(path: string): Promise<string | null> {
    const pending = route(path);
    if (!pending) return null;
    return JSON.stringify(await pending);
  }

  return { answer };
}

