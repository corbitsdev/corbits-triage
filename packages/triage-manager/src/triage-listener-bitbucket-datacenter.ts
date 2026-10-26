import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageListener } from "./triage-listener.js";

const manager = publishedFor("bitbucket-datacenter")?.manager;
if (!manager) throw new Error(`${TRIAGE_LISTENERS["bitbucket-datacenter"]} needs the release's manager in release.json, which the portal publishes beside it`);

export const workflow = triageListener({ id: TRIAGE_LISTENERS["bitbucket-datacenter"], manager });
