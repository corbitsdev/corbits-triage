import { TRIAGE_MANAGERS } from "@corbits/triage-contracts";
import { publishedFor, publishedReviewers } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const workflow = triageManager({ id: TRIAGE_MANAGERS["bitbucket-datacenter"], sources: ["bitbucket-datacenter"], codeReview: publishedReviewers("bitbucket-datacenter"), judge: publishedFor("bitbucket-datacenter", "judge") });
