import { TRIAGE_MANAGERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const workflow = triageManager({ id: TRIAGE_MANAGERS["bitbucket-datacenter"], sources: ["bitbucket-datacenter"], codeReview: publishedFor("bitbucket-datacenter", "codeReview"), judge: publishedFor("bitbucket-datacenter", "judge") });
