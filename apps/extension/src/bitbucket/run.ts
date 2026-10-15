// Spike: pr-triage's rules and evaluate steps on a Bitbucket Data Center pull request, read with the viewer's own session.
import { getChecks, getPr, getReviews, listIssueComments, listPrCommits, listPrFiles, readRepoFile, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { checkName, POLICY_FILE_PATH, readCheckPack, readPolicyFile, repoPolicy } from "@corbits/triage-contracts";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { rules } from "@corbits/triage-workflows/actions/rules";
import { assembleItem } from "@corbits/triage-workflows/logic/facts";
import { NEEDS_JUDGE_REASON, type Verdict } from "@corbits/triage-workflows/logic/render";
import { fileNotes } from "../notes.ts";
import { savedPackFor } from "../pack-store.ts";
import type { PolicyRead } from "../policy-source.ts";
import type { PrRef } from "../pr.ts";
import { posted, stateOf } from "../run-steps-in-browser.ts";
import type { TriageView, ViewRule } from "../view.ts";

type EffectContext = Parameters<typeof rules>[1];

const NO_EFFECTS: EffectContext = {
  async perform() {
    throw new Error("the extension performs no effects");
  },
};

const PR_PATH = /^\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/;

export function bitbucketPrFromUrl(url: string): PrRef | undefined {
  const match = PR_PATH.exec(new URL(url).pathname);
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : undefined;
}

/** Same-origin reads from the content script: the page's session cookie authenticates them, so no token and no host permission. */
export function sessionFetch(origin: string): BitbucketFetch {
  return function bb(path, init) {
    if ((init?.method ?? "GET") !== "GET") throw new Error("The extension only reads from Bitbucket.");
    return fetch(`${origin}${path}`, { ...init, credentials: "same-origin" });
  };
}

async function policyFor(bb: BitbucketFetch, repo: string): Promise<PolicyRead> {
  const file = await readRepoFile(bb, repo, POLICY_FILE_PATH);
  if (file?.kind === "file" && file.text !== null) return { pack: readCheckPack(readPolicyFile(file.text, repo), repo), origin: { from: "file", url: file.url } };
  if (file !== undefined) throw new Error(`${POLICY_FILE_PATH} cannot be read.`);
  return { pack: await savedPackFor(repo), origin: { from: "default" } };
}

export async function runBitbucket(bb: BitbucketFetch, pr: PrRef): Promise<TriageView> {
  const { repo, number } = pr;
  const { pack, origin } = await policyFor(bb, repo);
  const [read, reviews, comments, commits, files] = await Promise.all([
    getPr(bb, repo, number),
    getReviews(bb, repo, number),
    listIssueComments(bb, repo, number),
    listPrCommits(bb, repo, number),
    listPrFiles(bb, repo, number),
  ]);
  const checks = await getChecks(bb, read.sha);
  const item = assembleItem(number, { pr: read, checks, reviews, comments, commits, files, authorTeams: null }, { repo, policy: repoPolicy({}), pack, events: ["catch-up"], docs: { docs: {}, rules: {} } });
  const signal = new AbortController().signal;
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
  const ruledItem = ruled.items[0]!;
  const skipped = ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem;
  const verdict = (await evaluate({ items: [skipped], batch: false }, NO_EFFECTS, signal)) as Verdict;
  const named = verdict.checks.map((check) => ({ ...check, name: checkName(pack, check.check) }));
  const rows = named.map((check): ViewRule => ({ check: check.check, name: check.name, kind: check.kind, state: stateOf(check), reason: check.reason, evidence: check.evidence }));
  return {
    pr,
    headSha: ruledItem.facts.headSha,
    ranAt: new Date().toISOString(),
    policy: origin,
    modelAsked: false,
    rules: rows,
    decided: verdict.reason === NEEDS_JUDGE_REASON ? null : { verdict: verdict.verdict, ...posted(verdict, repo) },
    notes: fileNotes(named),
  };
}
