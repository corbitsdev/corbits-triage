// The pull request that writes a repository's policy file, on one branch so it is opened once:
// asking again updates the open one, and with none open the branch starts over from the default branch.
import { errorText } from "@corbits/common";
import { json, listPrCommits, readRepoFileResponse, requestError, type GithubFetch } from "@corbits/github-reads";
import { BitbucketFailed } from "../bitbucket-datacenter/client.js";
import { GithubRateLimited } from "./github-usage.js";

export const POLICY_BRANCH = "corbits-triage/policy";

/**
 * With `append`, an open pull request keeps its title and gets `body` added after its own as a section named by its
 * commit, and the commit message carries `body` so a section lost to a failed edit is added by the next batch; without,
 * it takes both. `readSha` is the sha of the file on the policy branch that `text` was built from, null when the branch
 * had none; set, a file that has changed since is refused with `PolicyFileMoved`.
 */
export type PolicyChange = { path: string; text: string; title: string; body: string; append?: boolean; readSha?: string | null };

export class PolicyFileMoved extends Error {
  constructor(readonly path: string) {
    super(`${path} changed since it was read`);
  }
}

/** The commit landed but the pull request's description could not be brought up to it. */
export class DescriptionNotUpdated extends Error {
  constructor(readonly commit: string | undefined, readonly reason: unknown) {
    super(`the policy pull request's description was not updated${commit === undefined ? "" : ` for commit ${commit}`}`);
  }
}

export function commitMessage({ title, body, append }: PolicyChange): string {
  return append ? `${title}\n\n${body}` : title;
}

const EDIT_DELAYS_MS = [100, 200, 400];

/**
 * A host answer of 429 or 5xx, or none at all, may pass, as may Bitbucket's 409 for a description edited since it was
 * read, which the next try reads again; the hub's own GitHub limit and any other refusal are final.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof GithubRateLimited) return false;
  if (err instanceof BitbucketFailed) return err.status === 409 || err.status === 429 || err.status >= 500;
  const status = /-> (\d{3})\b/.exec(errorText(err))?.[1];
  return status === undefined || status === "429" || status.startsWith("5");
}

/**
 * A batch's description edit, tried again after each of `EDIT_DELAYS_MS` while it fails in a way that may pass; still
 * failing so, it is `DescriptionNotUpdated`. Any other failure is thrown as the host gave it.
 */
export async function retriedEdit<T>(commit: string | undefined, edit: () => Promise<T>): Promise<T> {
  for (const delay of EDIT_DELAYS_MS) {
    try {
      return await edit();
    } catch (err) {
      if (!isTransient(err)) throw err;
    }
    await Bun.sleep(delay);
  }
  try {
    return await edit();
  } catch (err) {
    throw isTransient(err) ? new DescriptionNotUpdated(commit, err) : err;
  }
}

export type PolicyPull = { url: string; number: number; headSha?: string };

type Pull = { number: number; html_url: string; head: { sha: string }; body: string | null };

function pullOf(pull: Pull): PolicyPull {
  return { url: pull.html_url, number: pull.number, headSha: pull.head.sha };
}

async function openPull(gh: GithubFetch, repo: string, base: string): Promise<Pull | undefined> {
  const owner = repo.split("/", 1)[0];
  const pulls: Pull[] = await json(gh, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${POLICY_BRANCH}`)}&base=${encodeURIComponent(base)}`);
  return pulls[0];
}

export async function openPolicyPull(gh: GithubFetch, repo: string): Promise<PolicyPull | undefined> {
  const { default_branch: base } = await json(gh, `/repos/${repo}`);
  const pull = await openPull(gh, repo, base);
  return pull && pullOf(pull);
}

/** The branch at the default branch's head, made or moved there; a branch left from an earlier pull request is moved. */
async function branchFromBase(gh: GithubFetch, repo: string, base: string): Promise<void> {
  // Unverified against GitHub for a default branch whose name holds a slash.
  const head = await json(gh, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const res = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${POLICY_BRANCH}`, sha: head.object.sha }) });
  if (res.ok) return;
  if (res.status !== 422 || !(await res.text()).includes("Reference already exists")) throw new Error(`github POST /repos/${repo}/git/refs -> ${res.status}`);
  await json(gh, `/repos/${repo}/git/refs/heads/${POLICY_BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: head.object.sha, force: true }) });
}

/** The commit made, undefined when the branch already held the text. */
async function commitFile(gh: GithubFetch, repo: string, change: PolicyChange): Promise<string | undefined> {
  const { path, text, readSha } = change;
  const url = `/repos/${repo}/contents/${path}`;
  const current = await readRepoFileResponse(await gh(`${url}?ref=${encodeURIComponent(POLICY_BRANCH)}`, { headers: { accept: "application/vnd.github+json" } }), url);
  if (current?.kind === "file" && current.text === text) return undefined;
  const currentSha = current?.kind === "file" ? current.sha : undefined;
  if (readSha !== undefined && (currentSha ?? null) !== readSha) throw new PolicyFileMoved(path);
  const sha = currentSha === undefined ? {} : { sha: currentSha };
  const res = await gh(url, { method: "PUT", body: JSON.stringify({ message: commitMessage(change), content: Buffer.from(text, "utf8").toString("base64"), branch: POLICY_BRANCH, ...sha }) });
  // GitHub refuses the write with 409 when the file moved off `sha` after the read above.
  if (res.status === 409 && readSha !== undefined) throw new PolicyFileMoved(path);
  if (res.ok) return (await res.json() as { commit: { sha: string } }).commit.sha;
  const refused = await requestError(res, "PUT", url);
  // A file that appeared where none was read is refused with 422 for the sha the write did not name.
  if (res.status === 422 && readSha === null && /\bsha\b/.test(refused.message)) throw new PolicyFileMoved(path);
  throw refused;
}

/** One batch's part of the description, named by the commit that made it. */
type Section = { commit: string; text: string };
type BranchCommit = { commit: string; message: string };
/** The text before the first section, the newest commit whose section was dropped for length, and the sections kept. */
type Body = { opened: string; omitted?: string; sections: Section[] };

/** Starts each section, naming its commit; a Markdown comment, so it shows nothing. */
function marker(commit: string): string {
  return `[//]: # (corbits-triage added ${commit})`;
}
const MARKER = /^\[\/\/\]: # \(corbits-triage added ?([0-9A-Za-z]*)\)(?:\n\n([\s\S]*))?$/;
const OMITTED = /^\[\/\/\]: # \(corbits-triage omitted through ([0-9A-Za-z]+)\)(?:\n\n[\s\S]*)?$/;
const BEFORE_MARKER = /\n\n(?=\[\/\/\]: # \(corbits-triage (?:added|omitted through) )/;

function omission(commit: string): string {
  return `[//]: # (corbits-triage omitted through ${commit})\n\nEarlier batches are left out to fit the description.`;
}

/** Under GitHub's 65,536-character body limit, with room. */
export const PULL_BODY_MAX = 60_000;

const TRUNCATED = "\n(truncated)";

/** CRLF endings from an edit on the host are read as LF. */
function sectionsOf(body: string | null | undefined): Body {
  const chunks = (body ?? "").replace(/\r\n/g, "\n").trimEnd().split(BEFORE_MARKER);
  const opened = MARKER.test(chunks[0]!) || OMITTED.test(chunks[0]!) ? "" : chunks.shift()!;
  const omitted = OMITTED.exec(chunks[0] ?? "")?.[1];
  if (omitted !== undefined) chunks.shift();
  const sections = chunks.map(function sectionOf(chunk) {
    const [, commit = "", text = ""] = MARKER.exec(chunk) ?? [];
    return { commit, text };
  });
  return { opened, omitted, sections };
}

function joined({ opened, omitted, sections }: Body): string {
  const written = sections.map((section) => (section.text === "" ? marker(section.commit) : `${marker(section.commit)}\n\n${section.text}`));
  return [opened, omitted === undefined ? "" : omission(omitted), ...written].filter((part) => part !== "").join("\n\n");
}

/** `text` shortened by `over` characters and marked as cut; as it is when nothing is over. */
function cut(text: string, over: number): string {
  if (over <= 0) return text;
  return `${text.slice(0, Math.max(0, text.length - over - TRUNCATED.length))}${TRUNCATED}`;
}

/**
 * The description with `added` as its newest sections, never past `PULL_BODY_MAX`. The oldest sections lose their
 * text first but keep their marker, so their commits stay named and are not added again. When the markers alone are
 * too long, the oldest are dropped and one line says so, naming the newest commit dropped so the commits before it
 * are not added again either. Still too long, the newest section and then the opening lose their tail.
 */
export function bodyWith(body: string | null | undefined, added: readonly Section[]): string {
  const read = sectionsOf(body);
  const fitted: Body = { ...read, sections: [...read.sections, ...added] };
  const { sections } = fitted;
  for (const [at, section] of sections.slice(0, -1).entries()) {
    if (section.text === "") continue;
    if (joined(fitted).length <= PULL_BODY_MAX) break;
    sections[at] = { ...section, text: "" };
  }
  while (sections.length > 1 && joined(fitted).length > PULL_BODY_MAX) fitted.omitted = sections.shift()!.commit;
  const newest = sections.at(-1);
  if (newest !== undefined) sections[sections.length - 1] = { ...newest, text: cut(newest.text, joined(fitted).length - PULL_BODY_MAX) };
  fitted.opened = cut(fitted.opened, joined(fitted).length - PULL_BODY_MAX);
  return joined(fitted);
}

/**
 * The description a change that is not appended leaves: its own `body`, or, on a description holding batch sections,
 * those sections with the change added as one more, so later batches find every commit named.
 */
export function replacedBody(current: string | null | undefined, change: PolicyChange, committed: string | undefined): string {
  const read = sectionsOf(current);
  if (read.sections.length === 0 && read.omitted === undefined) return change.body;
  return bodyWith(current, committed === undefined ? [] : [{ commit: committed, text: change.body }]);
}

/** A section for each of the branch's batch commits, oldest first, that the description does not name or leave out yet. */
export function missingSections(body: string | null | undefined, commits: readonly BranchCommit[], title: string): Section[] {
  const { omitted, sections } = sectionsOf(body);
  const named = new Set(sections.map((section) => section.commit));
  const after = omitted === undefined ? 0 : commits.findIndex((row) => row.commit === omitted) + 1;
  // A message sent as a form field, as Bitbucket's is, comes back with CRLF endings.
  const batches = commits.slice(after).map((row) => ({ ...row, message: row.message.replace(/\r\n/g, "\n") })).filter((row) => !named.has(row.commit) && row.message.startsWith(`${title}\n\n`));
  return batches.map((row) => ({ commit: row.commit, text: row.message.slice(title.length + 2).trim() }));
}

/** The branch's commits with `committed`, which a listing read just after the write may not hold yet. */
export function withCommitted(commits: readonly BranchCommit[], committed: string | undefined, change: PolicyChange): BranchCommit[] {
  if (committed === undefined || commits.some((row) => row.commit === committed)) return [...commits];
  return [...commits, { commit: committed, message: commitMessage(change) }];
}

/** Adds a section for each batch commit the description lacks, the new one included; with none lacking, no edit is made. */
async function appendSections(gh: GithubFetch, repo: string, number: number, change: PolicyChange, committed: string | undefined): Promise<Pull> {
  const path = `/repos/${repo}/pulls/${number}`;
  return retriedEdit(committed, async function appendMissing() {
    // The description is read just before it is written; GitHub takes no version on the edit, and the hub runs one
    // batch per repository at a time.
    const latest: Pull = await json(gh, path);
    const listed = await listPrCommits(gh, repo, number);
    const commits = withCommitted(listed.map((row) => ({ commit: row.sha, message: row.message })), committed, change);
    const added = missingSections(latest.body, commits, change.title);
    if (added.length === 0) return latest;
    return json(gh, path, { method: "PATCH", body: JSON.stringify({ body: bodyWith(latest.body, added) }) });
  });
}

/** Opens the pull request, or brings the open one up to `change`. */
export async function proposePolicy(gh: GithubFetch, repo: string, change: PolicyChange): Promise<PolicyPull> {
  const { default_branch: base } = await json(gh, `/repos/${repo}`);
  const open = await openPull(gh, repo, base);
  if (!open) await branchFromBase(gh, repo, base);
  const committed = await commitFile(gh, repo, change);
  if (!open) return createPull(gh, repo, base, change, committed);
  const updated = pullOf(change.append ? await appendSections(gh, repo, open.number, change, committed) : await json(gh, `/repos/${repo}/pulls/${open.number}`, { method: "PATCH", body: JSON.stringify({ title: change.title, body: replacedBody(open.body, change, committed) }) }));
  // GitHub may answer the update before it has moved the pull request's head to the new commit.
  return committed === undefined ? updated : { ...updated, headSha: committed };
}

/** An appended pull request opens with its first batch as a section, so later batches see it named. */
export function openingBody(change: PolicyChange, committed: string | undefined): string {
  return change.append && committed !== undefined ? bodyWith("", [{ commit: committed, text: change.body }]) : change.body;
}

/** A pull request opened by a concurrent call in between is answered instead of refused. */
async function createPull(gh: GithubFetch, repo: string, base: string, change: PolicyChange, committed: string | undefined): Promise<PolicyPull> {
  const path = `/repos/${repo}/pulls`;
  const res = await gh(path, { method: "POST", headers: { accept: "application/vnd.github+json" }, body: JSON.stringify({ title: change.title, head: POLICY_BRANCH, base, body: openingBody(change, committed) }) });
  if (res.ok) return pullOf(await res.json() as Pull);
  const raced = res.status === 422 ? await openPull(gh, repo, base) : undefined;
  if (raced) return pullOf(raced);
  throw new Error(`github POST ${path} -> ${res.status}`);
}
