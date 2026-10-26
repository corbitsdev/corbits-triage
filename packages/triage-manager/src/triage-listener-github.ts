import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageListener } from "./triage-listener.js";

const manager = publishedFor("github")?.manager;
if (!manager) throw new Error(`${TRIAGE_LISTENERS["github"]} needs the release's manager in release.json, which the portal publishes beside it`);

export const workflow = triageListener({ id: TRIAGE_LISTENERS["github"], manager });
