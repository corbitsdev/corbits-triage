import { publishedFor } from "./release.js";
import { triageManager } from "./triage-manager.js";

export const TRIAGE_MANAGER_GITHUB_ADDRESS = "triage-manager-github";

const review = publishedFor("github")?.codeReview;

export const workflow = triageManager({ id: TRIAGE_MANAGER_GITHUB_ADDRESS, sources: ["github"], ...(review && { review }) });
