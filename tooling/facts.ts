import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { classifySignals, type TextSignals } from "../packages/triage-workflows/src/logic/signals.js";
import { renderVerdict, type RenderOutput } from "../packages/triage-workflows/src/logic/render.js";
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
  const v = renderVerdict({ author: pr.author, det: deriveState(toFacts(pr)) });
  return { ...v, humanGated: v.humanGated || pr.spam >= 0.9 || pr.confidence < 0.5 };
}
