import { type } from "arktype";
import { CodeReviewOutput } from "./code-review.js";
import { VerdictDetail } from "./hub-responses.js";

/** The grant on a pull request's manager claim and events that the hub's manager routes require. */
export const MANAGER_STATE_RESOURCE = "triage-manager:state";
export const MANAGER_STATE_ACTION = "write";

/** The grant a reviewer needs to report its result to the pull request's manager, and nothing else. */
export const MANAGER_RESULT_RESOURCE = "triage-manager:result";
export const MANAGER_RESULT_ACTION = "create";

const Reported = type({ head: "string > 0" });

/**
 * What a reviewer reports to its pull request's manager: the head it reviewed and its result, or why it has none; the
 * hub knows the reporting run from its run token.
 */
export const StageResult = Reported.and({ kind: "'code-review'", result: CodeReviewOutput })
  .or(Reported.and({ kind: "'judge'", result: VerdictDetail }))
  .or(Reported.and({ kind: "'code-review' | 'judge'", failed: "string > 0", "result?": "never" }));
export type StageResult = typeof StageResult.infer;
