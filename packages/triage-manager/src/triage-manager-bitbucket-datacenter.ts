import { publishedFor } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const TRIAGE_MANAGER_BITBUCKET_DATACENTER_ADDRESS = "triage-manager-bitbucket-datacenter";

const review = publishedFor("bitbucket-datacenter")?.codeReview;

export const workflow = triageManager({ id: TRIAGE_MANAGER_BITBUCKET_DATACENTER_ADDRESS, sources: ["bitbucket-datacenter"], ...(review && { review }) });
