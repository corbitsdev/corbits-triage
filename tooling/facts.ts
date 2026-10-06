import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { classifySignals, type TextSignals } from "../packages/triage-workflows/src/logic/signals.js";
import { render, type Rendered } from "../packages/rule-packs/src/index.js";
import type { PRRecord } from "../packages/triage-contracts/src/types.js";

export { classifySignals, type TextSignals };

export function toFacts(pr: PRRecord): PrFacts {
  return {
    repo: pr.repo,
    number: pr.id,
    title: pr.title,
    author: pr.author,
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

export function triage(pr: PRRecord): Rendered & { reason: string } {
  const d = deriveState(toFacts(pr));
  const humanGated = d.state === "needs-decision" || pr.spam >= 0.9 || pr.confidence < 0.5;
  return { ...render(d.state, { author: pr.author, reason: d.reason, humanGated }), reason: d.reason };
}
