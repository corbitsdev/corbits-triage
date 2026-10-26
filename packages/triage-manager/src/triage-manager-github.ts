import { TRIAGE_MANAGERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const workflow = triageManager({ id: TRIAGE_MANAGERS["github"], sources: ["github"], codeReview: publishedFor("github", "codeReview"), judge: publishedFor("github", "judge") });
