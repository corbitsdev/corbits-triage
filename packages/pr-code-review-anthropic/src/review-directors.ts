import { codeReviewDirectors } from "@corbits/pr-code-review/directors";
import { ANTHROPIC } from "./profile.js";

/** The one set of directors the agents and the `interchange.directors` module share. */
export const directors = codeReviewDirectors(ANTHROPIC);
