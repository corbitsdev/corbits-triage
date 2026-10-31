import { TRIAGE_MANAGERS } from "@corbits/triage-contracts";
import { publishedFor, publishedReviewers } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const workflow = triageManager({ id: TRIAGE_MANAGERS["github"], sources: ["github"], codeReview: publishedReviewers("github"), judge: publishedFor("github", "judge") });
