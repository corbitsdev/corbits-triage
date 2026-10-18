import { consolidateDirectorOf } from "./consolidate-director.js";
import type { CodeReviewProfile } from "./profile.js";
import { readerDirectorOf } from "./reader-director.js";
import { structuredDirectorOf } from "./structured-director.js";

/** The review's directors, namespaced by the provider's package; its `interchange.directors` module exports their factories. */
export function codeReviewDirectors(profile: CodeReviewProfile) {
  return { reader: readerDirectorOf(profile), consolidate: consolidateDirectorOf(profile), structured: structuredDirectorOf(profile) };
}

export type CodeReviewDirectors = ReturnType<typeof codeReviewDirectors>;
