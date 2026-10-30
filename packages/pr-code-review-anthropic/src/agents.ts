import { codeReviewAgents } from "@corbits/pr-code-review/agents";
import { sidecarDataDir } from "@corbits/repo-read-tool";
import { ANTHROPIC } from "./profile.js";
import { directors } from "./review-directors.js";

export type { Sources } from "@corbits/pr-code-review/agents";

export const agents = codeReviewAgents(ANTHROPIC, directors, sidecarDataDir);

export const { finderAgent } = agents;
