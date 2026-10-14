import { prTriage } from "./pr-triage.js";

export const workflow = prTriage({ sources: ["github", "bitbucket-datacenter"] });
