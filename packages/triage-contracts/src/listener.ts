import type { RepoSource } from "./repo-source.js";

/** Each host's listener by its definition id, also its mail address: a workspace with one live routes pull requests to managers. */
export const TRIAGE_LISTENERS: Record<RepoSource, string> = { github: "triage-listener-github", "bitbucket-datacenter": "triage-listener-bitbucket-datacenter" };
