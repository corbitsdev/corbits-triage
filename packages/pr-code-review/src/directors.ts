import { mailDirectorOf } from "@corbits/triage-manager/mail";
import { consolidateDirectorOf } from "./consolidate-director.js";
import type { CodeReviewProfile } from "./profile.js";
import { packageName } from "./package-name.js";
import { readerDirectorOf } from "./reader-director.js";
import { structuredDirectorOf } from "./structured-director.js";

/**
 * The review's directors, namespaced by the provider's package, reading checkouts under the data dir `dataDir` names;
 * its `interchange.directors` module exports their factories.
 */
export function codeReviewDirectors(profile: CodeReviewProfile, dataDir: () => string) {
  return { reader: readerDirectorOf(profile, dataDir), consolidate: consolidateDirectorOf(profile), structured: structuredDirectorOf(profile), mail: mailDirectorOf(packageName(profile.packageName)) };
}

export type CodeReviewDirectors = ReturnType<typeof codeReviewDirectors>;
