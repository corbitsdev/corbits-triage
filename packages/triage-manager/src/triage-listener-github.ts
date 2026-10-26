import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageListener } from "./triage-listener.js";

const manager = publishedFor("github")?.manager;
if (!manager) throw new Error(`${TRIAGE_LISTENERS["github"]} is built with the release's manager; a source run has none`);

export const workflow = triageListener({ id: TRIAGE_LISTENERS["github"], manager });
