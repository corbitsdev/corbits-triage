import { type } from "arktype";
import { VERDICTS } from "./check-pack.js";
import { CodeReviewOutput } from "./code-review.js";

/** The grant on a pull request's manager claim and events that the hub's manager routes require. */
export const MANAGER_STATE_RESOURCE = "triage-manager:state";
export const MANAGER_STATE_ACTION = "write";

/** The grant a reviewer needs to report its result to the pull request's manager, and nothing else. */
export const MANAGER_RESULT_RESOURCE = "triage-manager:result";
export const MANAGER_RESULT_ACTION = "create";

const Reported = type({ head: "string > 0" });

/**
 * A verdict whole, as pr-triage's evaluate made it, so the manager posts and executes it as the judge reported it: the
 * fields its mirror and execute read are checked, and every other is kept.
 */
export const JudgeVerdict = type({
  repo: "string",
  number: "number",
  headSha: "string | null",
  verdict: type.enumerated(...VERDICTS),
  checks: "object[]",
  request: "object",
  automatic: "string[]",
  actions: "object[]",
});
export type JudgeVerdict = typeof JudgeVerdict.infer;

/**
 * What a reviewer reports to its pull request's manager: the head it reviewed and its result, or why it has none; the
 * hub knows the reporting run from its run token.
 */
export const StageResult = Reported.and({ kind: "'code-review'", result: CodeReviewOutput })
  .or(Reported.and({ kind: "'judge'", result: JudgeVerdict }))
  .or(Reported.and({ kind: "'code-review' | 'judge'", failed: "string > 0", "result?": "never" }));
export type StageResult = typeof StageResult.infer;
