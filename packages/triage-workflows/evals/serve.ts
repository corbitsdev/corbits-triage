import { mailPayload } from "../../../apps/hub/src/github/bridge.js";
import { DEFAULT_REPO_POLICY, TRIAGE_MAIL_SENDER, type ActionKind, type CheckPack } from "../../triage-contracts/src/index.js";
import { PR_TRIAGE_ADDRESS } from "../src/pr-triage.js";
import type { IssueText, Snapshot } from "./cases.js";

const DOMAIN = "triage.test";
const HEAD = "e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1";

/**
 * Serves a fixture as GitHub would: the open pull request, its paged file rows, its docs as the default branch's tree
 * and blobs, each repository's pull request templates, by name, as its `.github/PULL_REQUEST_TEMPLATE/` folder, and
 * `issue` as the issue the pull request closes.
 */
export function fixtureGithub(pr: Snapshot, templates: Readonly<Record<string, readonly string[]>>, issue?: IssueText & { number: number }) {
  const repo = `/repos/${pr.repo}`;
  const folder = ".github/PULL_REQUEST_TEMPLATE";
  const templateFiles = Object.entries(templates).flatMap(([name, texts]) => texts.map((text, index) => ({ repo: name, name: `${index}.md`, path: `${folder}/${index}.md`, type: "file", text })));
  function filesOf(name: string) {
    return templateFiles.filter((file) => file.repo === name);
  }
  const docs = Object.entries(pr.docs);
  const pull = {
    number: pr.number, title: pr.title, body: pr.body, body_html: pr.bodyHtml, state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean",
    user: { login: pr.author, type: "User" }, head: { sha: HEAD, ref: "eval" }, base: { ref: "main" },
    additions: pr.files.reduce((sum, file) => sum + file.additions, 0), deletions: pr.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pr.files.length, labels: [], requested_reviewers: [], requested_teams: [], assignees: [],
  };
  return async function fetchFixture(url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === repo) return Response.json({ default_branch: "main", owner: { login: pr.repo.split("/")[0], type: "Organization" } });
    if (path === `${repo}/pulls`) return Response.json([pull]);
    if (path === `${repo}/pulls/${pr.number}`) return Response.json(pull);
    if (path === `${repo}/pulls/${pr.number}/commits`) return Response.json(pr.commits.map((message) => ({ commit: { message } })));
    if (path === `${repo}/pulls/${pr.number}/reviews` || path === `${repo}/issues/${pr.number}/comments`) return Response.json([]);
    if (issue && path === `${repo}/issues/${issue.number}`) return Response.json({ number: issue.number, title: issue.title, body: issue.body });
    if (path.startsWith(`${repo}/commits/`)) return Response.json({ check_runs: [] });
    const listed = Object.keys(templates).find((name) => path === `/repos/${name}/contents/.github`);
    if (listed !== undefined) return Response.json(filesOf(listed).length ? [{ name: "PULL_REQUEST_TEMPLATE", path: folder, type: "dir" }] : []);
    const inFolder = Object.keys(templates).find((name) => path === `/repos/${name}/contents/${folder}`);
    if (inFolder !== undefined) return Response.json(filesOf(inFolder).map(({ name, path: at, type }) => ({ name, path: at, type })));
    const template = templateFiles.find((file) => path === `/repos/${file.repo}/contents/${file.path}`);
    if (template) return Response.json({ type: "file", sha: template.name, encoding: "base64", content: Buffer.from(template.text).toString("base64"), html_url: `https://github.com/${template.repo}/blob/main/${template.path}` });
    if (path === `${repo}/pulls/${pr.number}/files`) {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json(pr.files.slice((page - 1) * perPage, page * perPage));
    }
    if (path.startsWith(`${repo}/git/trees/`)) {
      return Response.json({ sha: "tree", tree: docs.map(([doc, text], index) => ({ path: doc, type: "blob", sha: String(index), size: new TextEncoder().encode(text).byteLength })) });
    }
    const blob = path.startsWith(`${repo}/git/blobs/`) ? docs[Number(path.slice(`${repo}/git/blobs/`.length))] : undefined;
    return blob ? new Response(blob[1]) : new Response(null, { status: 404 });
  };
}

/** The mail the hub's bridge sends when a pull request opens, as stock hands it to the run, with `extra` beside its request's own fields and `automatic` the kinds triage may run unattended. */
export function triggerMail(pr: Pick<Snapshot, "repo" | "number">, pack: CheckPack, extra: Record<string, unknown> = {}, automatic: ActionKind[] = []) {
  const request = mailPayload({ name: pr.repo }, { ...DEFAULT_REPO_POLICY, enabled: true }, { pack, automatic, source: { repo: { id: "eval", version: 1 } } }, { ...extra, prNumber: pr.number, headSha: HEAD, events: ["opened"] });
  return {
    headers: { from: `${TRIAGE_MAIL_SENDER}@${DOMAIN}`, to: [`${PR_TRIAGE_ADDRESS}@${DOMAIN}`] },
    rawHeaders: {},
    parts: [{ contentType: "text/plain", ref: "part-0", text: JSON.stringify({ ...request, appLogin: "triage-eval[bot]" }) }],
  };
}
