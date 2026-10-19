import { codeReviewDirectors } from "@corbits/pr-code-review/directors";
import { sidecarDataDir } from "@corbits/repo-read-tool";
import { ANTHROPIC } from "./profile.js";

/** The one set of directors the agents and the `interchange.directors` module share. */
export const directors = codeReviewDirectors(ANTHROPIC, sidecarDataDir);
