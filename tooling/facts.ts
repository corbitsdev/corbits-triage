import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { classifySignals, type TextSignals } from "../packages/triage-workflows/src/logic/signals.js";
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
    checks: pr.checks ? "success" : "failure",
    approvals: 0,
  };
}

export function triage(pr: PRRecord): RenderOutput {
  const facts = toFacts(pr);
  const v = renderVerdict({ author: pr.author, repo: facts.repo, headSha: facts.headSha, det: deriveState(facts), threshold: DEFAULT_MERGE_THRESHOLD });
  return { ...v, humanGated: v.humanGated || pr.spam >= 0.9 || pr.confidence < 0.5 };
}
