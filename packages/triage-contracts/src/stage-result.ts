import { type } from "arktype";
import { CodeReviewOutput } from "./code-review.js";
import { VerdictDetail } from "./hub-responses.js";

const Reported = type({ head: "string > 0" });

/** What a reviewer reports to its pull request's manager: the head it reviewed and its result; the hub knows the reporting run from its run token. */
export const StageResult = Reported.and({ kind: "'code-review'", result: CodeReviewOutput }).or(Reported.and({ kind: "'judge'", result: VerdictDetail }));
export type StageResult = typeof StageResult.infer;
