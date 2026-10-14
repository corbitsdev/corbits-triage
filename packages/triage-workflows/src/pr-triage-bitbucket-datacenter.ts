import { prTriage } from "./pr-triage.js";

export const PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS = "pr-triage-bitbucket-datacenter";

export const workflow = prTriage({ id: PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS, sources: ["bitbucket-datacenter"] });
