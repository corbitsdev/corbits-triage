import type { Case } from "@corbits/evals";
import { isDocPath } from "../../triage-contracts/src/paths.js";

type Outcome = "pass" | "fail" | "unsure";

export const MODEL_CHECKS = ["docs", "focused", "ticket-goals"] as const;
export type ModelCheck = typeof MODEL_CHECKS[number];
/** Each judged rule's answer, the verdict's, and whether the judge found the pull request directing it. */
export const SCORED = [...MODEL_CHECKS, "verdict", "instructed"] as const;
export type Scored = typeof SCORED[number];
/** A case skips the judged rules it leaves out. */
export type Expected = Partial<Record<ModelCheck, Outcome>> & { verdict: Outcome; instructed: "yes" | "no" };

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
  /** Pull requests that close an issue whose work they do, by `owner/name#number`, with the issue they close and how that was checked. */
  tickets: Record<string, Omit<Label, "needsDocs"> & { issue: number }>;
  /** Text added to a labelled pull request, which `instructs` when it tries to direct the judge. */
  injections: Array<{ name: string; pull: string; drop?: "docs"; inject: Injection; instructs: boolean }>;
}

/** Text added where an author or an earlier merge could put it: the body, a commit subject, a line of the first changed code file, or the top of the README. */
export interface Injection {
  into: "body" | "commit" | "diff" | "doc";
  text: string;
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
  /** GitHub's rendering of `body`, which the facts step reads. */
  bodyHtml: string;
  author: string;
  commits: string[];
  files: FileRow[];
  docs: Record<string, string>;
}

/** An issue as GitHub serves it. */
export interface IssueText {
  title: string;
  body: string;
}

/** Which snapshot a case reads, and what it removes or adds. */
export interface CaseInput {
  pull: string;
  /** The ticket pull request whose issue is served as this pull request's own, with only the ticket-goals rule on. */
  issue?: string;
  drop?: "docs";
  mix?: string;
  /** The mix's title and body describe both pull requests. */
  described?: true;
  inject?: Injection;
}

export type JudgeCase = Case<CaseInput, Expected> & { name: string };

/** Commit subjects that mention the docs a variant removed, which a real pull request without them would not have. */
const MENTIONS_DOCS = /\b(docs?|readme|documentation)\b/i;

function injected(pr: Snapshot, { into, text }: Injection): Snapshot {
  switch (into) {
    case "body":
      return { ...pr, body: `${pr.body}\n\n${text}`, bodyHtml: `${pr.bodyHtml}\n<p dir="auto">${text}</p>` };
    case "commit":
      return { ...pr, commits: [...pr.commits, text] };
    case "diff": {
      const at = pr.files.findIndex((file) => file.patch !== undefined && !isDocPath(file.filename));
      if (at === -1) throw new Error(`${pr.repo}#${pr.number} changes no code file to add a line to`);
      return { ...pr, files: pr.files.map((file, index) => (index === at ? { ...file, additions: file.additions + 1, patch: `${file.patch}\n+${text}` } : file)) };
    }
    case "doc": {
      const readme = pr.docs["README.md"];
      if (readme === undefined) throw new Error(`${pr.repo} has no README.md to add to`);
      return { ...pr, docs: { ...pr.docs, "README.md": `${text}\n\n${readme}` } };
    }
  }
}

/** The snapshot a case describes: files dropped or merged in, with text that would contradict the variant removed, and any text injected. */
export function variant(base: Snapshot, input: CaseInput, other?: Snapshot): Snapshot {
  const pr = changed(base, input, other);
  return input.inject ? injected(pr, input.inject) : pr;
}

function changed(base: Snapshot, input: CaseInput, other?: Snapshot): Snapshot {
  if (input.mix !== undefined) {
    if (!other) throw new Error(`case ${input.pull}+${input.mix} needs ${input.mix}`);
    const mixed = { ...base, files: [...base.files, ...other.files], commits: [...base.commits, ...other.commits] };
    return input.described ? { ...mixed, title: `${base.title}; also ${other.title}`, body: `${base.body}\n\nAlso: ${other.body}`, bodyHtml: `${base.bodyHtml}\n<p dir="auto">Also:</p>\n${other.bodyHtml}` } : mixed;
  }
  if (input.drop === undefined) return base;
  return { ...base, body: "", bodyHtml: "", commits: base.commits.filter((commit) => !MENTIONS_DOCS.test(commit)), files: base.files.filter((file) => !isDocPath(file.filename)) };
}
