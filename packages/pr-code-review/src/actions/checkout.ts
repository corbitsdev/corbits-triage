import { lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { readPrDiff as bitbucketDiff, readPrHead as bitbucketHead } from "@corbits/bitbucket-datacenter-reads";
import { checkout as bitbucketCheckout } from "@corbits/bitbucket-datacenter-tool";
import { readReviewDiscussions as bitbucketDiscussions } from "@corbits/bitbucket-datacenter-tool/bitbucket";
import { diffHash } from "@corbits/common/diff-hash";
import { readPr as githubPr, readPrDiff as githubDiff, readReviewDiscussions as githubDiscussions } from "@corbits/github-reads";
import { PreviousReview } from "@corbits/triage-contracts";
import { checkout as githubCheckout } from "@corbits/github-tool";
import { checkoutsUnder, checkTarget, sidecarDataDir } from "@corbits/repo-read-tool";
import type { EffectContext, PerformScope } from "@intx/workflow";
import { type } from "arktype";
import { DIFF_DIR, DIFF_INDEX, indexedFiles, indexText } from "../diff-parts.js";
import { changesBetween } from "../changes.js";

export const Checkout = type({ source: "'github' | 'bitbucket-datacenter'", repo: "string", sha: /^[0-9a-f]{40}$/ });
export type Checkout = typeof Checkout.infer;

/** The checkout action's input: the head, and the pull request whose diff it reads and writes beside the checkout. */
const CheckoutInput = Checkout.and({ number: "number.integer > 0", "previous?": PreviousReview });

/**
 * What the checkout action returns: the checkout's folder, the pull request's whole diff, which the later steps read,
 * and its hash, which the review reports so a later head with the same diff can take the review over.
 */
export interface CheckedOut {
  path: string;
  diff: string;
  diffHash?: string;
  previous?: PreviousReview;
  changes?: string;
}

const DISCUSSIONS = { github: githubDiscussions, "bitbucket-datacenter": bitbucketDiscussions };
export const REVIEW_CHANGES = `${DIFF_DIR}/since-review.patch`;

async function discussedHistory(host: HostFetch, target: Checkout, number: number, previous: PreviousReview): Promise<PreviousReview> {
  const ids = [...new Set(previous.comments.map((finding) => finding.thread.id))];
  const discussions = await DISCUSSIONS[target.source](host, target.repo, number, ids);
  const comments = previous.comments.flatMap(function refreshed(finding) {
    const discussion = discussions.find((thread) => thread.id === finding.thread.id);
    if (!discussion) return [];
    const { comments: _comments, ...thread } = discussion;
    return [{ ...finding, thread }];
  });
  return { ...previous, comments, discussions };
}

export const READ_FILE_TOOL = { github: "github_read_file", "bitbucket-datacenter": "bitbucket_datacenter_read_file" } as const;

/** The effect capability the checkout action declares: it reads the repository from its host. */
export const READ_REPOSITORY = "repository.read";

type HostFetch = (path: string, init?: RequestInit) => Promise<Response>;

const DOWNLOAD: Record<Checkout["source"], (host: HostFetch, repo: string, sha: string, dir: string) => Promise<unknown>> = {
  github: githubCheckout,
  "bitbucket-datacenter": bitbucketCheckout,
};

type PullReads = { head(host: HostFetch, repo: string, number: number): Promise<string>; diff(host: HostFetch, repo: string, number: number): Promise<string> };

/** Each host's reads of a pull request's head and diff, the ones the hub uses. */
const PULL: Record<Checkout["source"], PullReads> = {
  github: {
    async head(host, repo, number) {
      return (await githubPr(host, repo, number)).sha;
    },
    diff: githubDiff,
  },
  "bitbucket-datacenter": { head: bitbucketHead, diff: bitbucketDiff },
};

/**
 * The pull request's diff at the pinned head. The host reads the diff by pull request, not by head, and GitHub rebuilds
 * a very large one from the file list, so the head is read before and after, and a push in between fails the review.
 */
async function pinnedDiff(host: HostFetch, { source, repo, sha }: Checkout, number: number): Promise<string> {
  const reads = PULL[source];
  async function requirePinnedHead() {
    const head = await reads.head(host, repo, number);
    if (head !== sha) throw new Error(`checkout: the head moved from ${sha} to ${head}`);
  }
  await requirePinnedHead();
  const diff = await reads.diff(host, repo, number);
  await requirePinnedHead();
  // A host that ignores the diff media type answers JSON, which would be reviewed as if it were the change.
  if (diff !== "" && !diff.startsWith("diff ")) throw new Error(`checkout: ${repo}#${number}: the host returned no unified diff`);
  return diff;
}

/** Where the sidecar keeps the checkout of `repo` at `sha`: one folder per host, repository and head. */
export function checkoutPath(dataDir: string, { source, repo, sha }: Checkout): string {
  checkTarget(repo, sha);
  return join(checkoutsUnder(dataDir), source, ...repo.split("/"), sha);
}

/** Whether the checkout is there; its folder exists only once complete. */
export async function isCheckedOut(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Downloads beside the checkout, replacing what an interrupted download left there, and renames it into place, so a
 * partial download is never read. Each review is a worker deployment of its own, whose sidecar, checkout included, is
 * removed when its run ends, so no other run downloads the same head.
 */
async function download(host: HostFetch, { source, repo, sha }: Checkout, path: string) {
  const staging = `${path}.partial`;
  try {
    await DOWNLOAD[source](host, repo, sha, staging);
    await rename(staging, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The host as the credential bound for `source` reaches it. */
async function hostOf(credentials: PerformScope["credentials"], source: Checkout["source"]): Promise<HostFetch> {
  const mediated = await credentials.resolve(source);
  if (mediated.kind !== "http") throw new Error(`${source} credential must be http, got ${mediated.kind}`);
  return function host(hostPath: string, init?: RequestInit) {
    return mediated.fetch(hostPath, init);
  };
}

/**
 * Where the checkout action writes the diff of the checkout at `path`: beside it, never inside the tree the pull request
 * controls, which could hold a link or file in its way. The read tools show it at DIFF_DIR.
 */
export function diffDirOf(path: string): string {
  return `${path}.diff`;
}

/** The folder at `dir` made afresh, replacing one an earlier run left; anything else there fails the action. */
async function freshDir(dir: string) {
  try {
    if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} exists and is not a folder`);
    await rm(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dir);
}

/** Writes each changed file's patch parts and the index naming them beside the checkout at `path`. */
async function writeDiff(path: string, diff: string) {
  const files = indexedFiles(diff);
  const dir = diffDirOf(path);
  await freshDir(dir);
  function inDir(shown: string) {
    return join(dir, posix.relative(DIFF_DIR, shown));
  }
  for (const part of files.flatMap((file) => file.parts)) await writeFile(inDir(part.path), part.text, { flag: "wx" });
  await writeFile(inDir(DIFF_INDEX), indexText(files), { flag: "wx" });
}

/**
 * The checkout action over the sidecar data dir `dataDir` names: the pull request's whole diff at the head, read through
 * the host's credential, and the head's folder, downloaded unless already there, with the diff written beside it
 * (diffDirOf).
 */
export function checkoutUnder(dataDir: () => string) {
  return async function checkout(input: unknown, ctx: EffectContext): Promise<CheckedOut> {
    const parsed = CheckoutInput(input);
    if (parsed instanceof type.errors) throw new Error(`checkout: invalid input: ${parsed.summary}`);
    const { number, previous, ...target } = parsed;
    const path = checkoutPath(dataDir(), target);
    async function run({ credentials }: PerformScope): Promise<CheckedOut> {
      const host = await hostOf(credentials, target.source);
      const diff = await pinnedDiff(host, target, number);
      if (!(await isCheckedOut(path))) await download(host, target, path);
      await writeDiff(path, diff);
      const hash = diffHash(diff);
      if (!previous) return { path, diff, ...(hash && { diffHash: hash }) };
      const earlier = { ...target, sha: previous.head };
      const before = checkoutPath(dataDir(), earlier);
      if (!(await isCheckedOut(before))) await download(host, earlier, before);
      const changes = await changesBetween(dirname(path), previous.head, target.sha);
      await writeFile(join(diffDirOf(path), "since-review.patch"), changes, { flag: "wx" });
      const history = await discussedHistory(host, target, number, previous);
      return { path, diff, ...(hash && { diffHash: hash }), previous: history, changes };
    }
    return (await ctx.perform({ effectId: "checkout", capability: READ_REPOSITORY, run })) as CheckedOut;
  };
}

export const checkout = checkoutUnder(sidecarDataDir);

// The repository finder's and consolidate directors read the repository and head from the first line of their input message.
const REPOSITORY_TAG = /^<repository host="(github|bitbucket-datacenter)" name="([^"]+)" head="([0-9a-f]{40})"\/>\n/;

export function repositoryTag({ source, repo, sha }: Checkout): string {
  return `<repository host="${source}" name="${repo}" head="${sha}"/>\n`;
}

/** The repository and head an input message names, if any. */
export function checkoutOf(text: string): Checkout | undefined {
  const match = REPOSITORY_TAG.exec(text);
  if (!match) return undefined;
  const [, source, repo, sha] = match;
  return { source: source as Checkout["source"], repo: repo!, sha: sha! };
}

export const DEFAULT_BUDGET = 400_000;
/** Each check verifies one finding, so it reads on a smaller budget; one refused a read for it is unsure. */
export const DEFAULT_CHECK_BUDGET = 100_000;
/** What all of a review's checks may read together, handed out up front in review order; a finding left without any is unsure. */
export const DEFAULT_CHECK_TOTAL = 400_000;

// A director that reads the repository on a budget of billable tokens reads it from its own line.
const BUDGET_TAG = /^<budget tokens="(\d+)"\/>\n/m;

export function budgetTag(tokens: number): string {
  return `<budget tokens="${tokens}"/>\n`;
}

/** The token budget an input message names, if any. */
export function budgetOf(text: string): number | undefined {
  const match = BUDGET_TAG.exec(text);
  return match ? Number(match[1]) : undefined;
}

// A reader whose budget ran out marks its reply with this line, so the review can say it stopped early.
export const BUDGET_EXHAUSTED = "<budget_exhausted/>\n";
