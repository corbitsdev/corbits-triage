import { prTriage } from "./pr-triage.js";

export const PR_TRIAGE_GITHUB_ADDRESS = "pr-triage-github";

export const workflow = prTriage({ id: PR_TRIAGE_GITHUB_ADDRESS, sources: ["github"] });
