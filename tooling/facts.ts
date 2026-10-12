import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { classifySignals, type TextSignals } from "../packages/triage-workflows/src/logic/signals.js";
import { prepareQualityEvaluation } from "../packages/triage-workflows/src/logic/quality.js";
import { renderVerdict, type RenderOutput } from "../packages/triage-workflows/src/logic/render.js";
import { DEFAULT_MERGE_THRESHOLD } from "../packages/triage-contracts/src/check-pack.js";
import type { PRRecord } from "../packages/triage-contracts/src/types.js";

export { classifySignals, type TextSignals };

export function toFacts(pr: PRRecord): PrFacts {
  return {
    repo: pr.repo,
    number: pr.id,
    title: pr.title,
    author: pr.author,
    tier: pr.tier,
    headSha: pr.revision,
    state: pr.state,
    draft: pr.draft,
    mergeable: pr.conflicts ? false : true,
    baseBehindBy: pr.drift ? 60 : 0,
    checks: pr.checks ? "success" : "failure",
    requestedReviewers: pr.reviewers ? 1 : 0,
    approvals: 0,
    openPrs: pr.duplicate >= 0.85 ? [{ number: -pr.id, title: pr.title }] : [],
  };
}

export function triage(pr: PRRecord): RenderOutput {
  const facts = toFacts(pr);
  const det = deriveState(facts);
  const { focused } = prepareQualityEvaluation(facts, det.sources);
  const v = renderVerdict({ author: pr.author, repo: facts.repo, headSha: facts.headSha, det, focused, threshold: DEFAULT_MERGE_THRESHOLD });
  return { ...v, humanGated: v.humanGated || pr.spam >= 0.9 || pr.confidence < 0.5 };
}
