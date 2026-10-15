import type { Case } from "@corbits/evals";
import { isDocPath } from "../../triage-contracts/src/paths.js";

type Outcome = "pass" | "fail";

export const MODEL_CHECKS = ["docs", "focused"] as const;
export type ModelCheck = typeof MODEL_CHECKS[number];
/** Each judged rule's answer, and the verdict question's. */
export const SCORED = [...MODEL_CHECKS, "verdict"] as const;
export type Scored = typeof SCORED[number];
export type Expected = Record<Scored, Outcome>;

/** What a reviewer decided about a merged pull request; generate-cases.ts derives each case's expectations from it. */
interface Label {
  needsDocs: boolean;
  note: string;
  /** The head and base the label was measured at, so later pushes to the pull request do not change its fixture. */
  headSha: string;
  baseSha: string;
}

export interface Labels {
  /** By number in this repository, or `owner/name#number` in another. */
  pulls: Record<string, Label>;
  /** Pull requests whose files are merged into one unfocused pull request, the first giving the title and body. */
  mixes: Array<[string, string]>;
  /** Mixes whose title and body describe both pull requests, as an author bundling two changes would. */
  describedMixes: Array<[string, string]>;
}

/** A file row as GitHub's pull request files API returns it. */
export interface FileRow {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** A merged pull request as GitHub served it, with the repository's docs at its base by path. */
export interface Snapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  commits: string[];
  files: FileRow[];
  docs: Record<string, string>;
}

/** Which snapshot a case reads, and what it removes or adds. */
export interface CaseInput {
  pull: string;
  drop?: "docs";
  mix?: string;
  /** The mix's title and body describe both pull requests. */
  described?: true;
}

export type JudgeCase = Case<CaseInput, Expected> & { name: string };

/** Commit subjects that mention the docs a variant removed, which a real pull request without them would not have. */
const MENTIONS_DOCS = /\b(docs?|readme|documentation)\b/i;

/** The snapshot a case describes: files dropped or merged in, with text that would contradict the variant removed. */
export function variant(base: Snapshot, input: CaseInput, other?: Snapshot): Snapshot {
  if (input.mix !== undefined) {
    if (!other) throw new Error(`case ${input.pull}+${input.mix} needs ${input.mix}`);
    const mixed = { ...base, files: [...base.files, ...other.files], commits: [...base.commits, ...other.commits] };
    return input.described ? { ...mixed, title: `${base.title}; also ${other.title}`, body: `${base.body}\n\nAlso: ${other.body}` } : mixed;
  }
  if (input.drop === undefined) return base;
  return { ...base, body: "", commits: base.commits.filter((commit) => !MENTIONS_DOCS.test(commit)), files: base.files.filter((file) => !isDocPath(file.filename)) };
}
