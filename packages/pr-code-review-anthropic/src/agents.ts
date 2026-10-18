import { codeReviewAgents } from "@corbits/pr-code-review/agents";
import { ANTHROPIC } from "./profile.js";
import { directors } from "./review-directors.js";

export type { Sources } from "@corbits/pr-code-review/agents";

export const agents = codeReviewAgents(ANTHROPIC, directors);

export const { finderAgent, repoFinderAgent } = agents;
