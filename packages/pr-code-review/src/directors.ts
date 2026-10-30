import type { CodeReviewProfile } from "./profile.js";
import { readerDirectorOf } from "./reader-director.js";

/** Provider-namespaced reader, confined to checkouts under the sidecar data directory. */
export function codeReviewDirectors(profile: CodeReviewProfile, dataDir: () => string) {
  return { reader: readerDirectorOf(profile, dataDir) };
}
export type CodeReviewDirectors = ReturnType<typeof codeReviewDirectors>;
