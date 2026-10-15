import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { prepareQualityEvaluation } from "../packages/triage-workflows/src/logic/quality.js";
import { renderVerdict, type RenderOutput } from "../packages/triage-workflows/src/logic/render.js";
import { NO_FACTS } from "../packages/triage-workflows/src/logic/item.js";
import type { PRRecord } from "../packages/triage-contracts/src/types.js";

function toFacts(pr: PRRecord): PrFacts {
  return {
    ...NO_FACTS,
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
  const det = deriveState(facts);
  const { focused } = prepareQualityEvaluation(facts, det.sources);
  const v = renderVerdict({ author: pr.author, repo: facts.repo, headSha: facts.headSha, det, focused });
  return { ...v, humanGated: v.humanGated || pr.spam >= 0.9 || pr.confidence < 0.5 };
}
