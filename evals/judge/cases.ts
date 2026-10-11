import type { Case } from "@corbits/evals";

type Outcome = "pass" | "fail";

export const MODEL_CHECKS = ["tests", "docs", "focused"] as const;
export type ModelCheck = typeof MODEL_CHECKS[number];
export type Expected = Record<ModelCheck, Outcome>;

/** What a reviewer decided about a merged pull request; snapshot.ts derives each case's expectations from it. */
export interface Label {
  needsTests: boolean;
  needsDocs: boolean;
  note: string;
}

export interface Labels {
  repo: string;
  pulls: Record<string, Label>;
  /** Pull requests whose files are merged into one unfocused pull request, the first giving the title and body. */
  mixes: Array<[number, number]>;
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

/** A merged pull request frozen as GitHub served it, with the repository's docs at its base by path. */
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

/** A snapshot as stored: each doc names its text in docs/<hash>.md, which pull requests share. */
export type StoredSnapshot = Omit<Snapshot, "docs"> & { docs: Record<string, string> };

/** Which snapshot a case reads, and what it removes or adds. */
export interface CaseInput {
  pull: number;
  drop?: "tests" | "docs";
  mix?: number;
}

export type JudgeCase = Case<CaseInput, Expected> & { name: string };

export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

const FOREIGN_PATH = /(^|\/)(vendor|node_modules|dist|build)\//;
const LEGAL_DOC = /(^|\/)(LICENSE|COPYING|CLA|SECURITY|CODE_OF_CONDUCT)[^/]*$|exception[^/]*$/i;

/** The repository's own prose: every markdown file outside vendored or built trees, except legal notices. */
export function isDocPath(path: string): boolean {
  return /\.mdx?$/i.test(path) && !FOREIGN_PATH.test(path) && !LEGAL_DOC.test(path);
}

/** Commit subjects that mention what a variant removed, which a real pull request without it would not have. */
const MENTIONS: Record<NonNullable<CaseInput["drop"]>, RegExp> = { tests: /\btest/i, docs: /\b(docs?|readme|documentation)\b/i };

/** The snapshot a case describes: files dropped or merged in, with text that would contradict the variant removed. */
export function variant(base: Snapshot, input: CaseInput, other?: Snapshot): Snapshot {
  if (input.mix !== undefined) {
    if (!other) throw new Error(`case ${input.pull}+${input.mix} needs #${input.mix}`);
    return { ...base, files: [...base.files, ...other.files], commits: [...base.commits, ...other.commits] };
  }
  if (input.drop === undefined) return base;
  const drop = input.drop === "tests" ? isTestPath : isDocPath;
  const mentions = MENTIONS[input.drop];
  return { ...base, body: "", commits: base.commits.filter((commit) => !mentions.test(commit)), files: base.files.filter((file) => !drop(file.filename)) };
}
