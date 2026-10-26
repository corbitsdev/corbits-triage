import { publishedFor } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const TRIAGE_MANAGER_GITHUB_ADDRESS = "triage-manager-github";

export const workflow = triageManager({ id: TRIAGE_MANAGER_GITHUB_ADDRESS, sources: ["github"], codeReview: publishedFor("github", "codeReview") });
