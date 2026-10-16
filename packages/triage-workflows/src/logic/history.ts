import { isDocPath } from "@corbits/triage-contracts/paths";
import type { ClosedPr } from "@corbits/github-reads";
import type { AuthorKind } from "@corbits/triage-contracts";
import type { RulesItem } from "../actions/rules.js";
import { issueReference, type PrFacts } from "./checks.js";

/** What the facts director reads for a scan: the closed pull requests, newest first, and each one's facts in the same order. */
export interface History {
  repo: string;
  closed: ClosedPr[];
  items: RulesItem[];
}

export type Outcome = "merged" | "closed";

export interface HistoryRecord {
  number: number;
  outcome: Outcome;
  closedAt: string;
  author: string;
  authorKind: AuthorKind | "unknown";
  draft: boolean;
  lines: number;
  files: number;
  docsOnly: boolean;
  linkedIssue: boolean;
  checks: PrFacts["checks"];
  approvals: number;
  changesRequested: boolean;
}

export interface Bucket {
  signal: string;
  bucket: string;
  merged: number;
  closed: number;
}

export interface Measured {
  repo: string;
  records: HistoryRecord[];
  /** Pull requests whose facts could not be read, with why. */
  unread: Array<{ number: number; error: string }>;
  buckets: Bucket[];
}

function record(pr: ClosedPr, facts: PrFacts): HistoryRecord {
  return {
    number: pr.number,
    outcome: pr.merged ? "merged" : "closed",
    closedAt: pr.closedAt,
    author: facts.author,
    authorKind: facts.authorKind ?? "unknown",
    draft: facts.draft,
    lines: facts.additions + facts.deletions,
    files: facts.changedFiles,
    docsOnly: facts.paths.length > 0 && facts.paths.every(isDocPath),
    linkedIssue: issueReference(facts, "either") !== null,
    checks: facts.checks,
    approvals: facts.approvals,
    changesRequested: facts.changesRequested.length > 0,
  };
}

type Split = { signal: string; bucketOf: (r: HistoryRecord) => string; order?: string[] };

/** Upper bounds, each bucket holding values above the previous bound. */
function sized(signal: string, bounds: number[], value: (r: HistoryRecord) => number): Split {
  const order = [...bounds.map((bound, i) => (i === 0 ? `≤ ${bound}` : `${bounds[i - 1]! + 1}–${bound}`)), `> ${bounds.at(-1)}`];
  return {
    signal,
    order,
    bucketOf(r) {
      const i = bounds.findIndex((bound) => value(r) <= bound);
      return order[i === -1 ? bounds.length : i]!;
    },
  };
}

function yesNo(signal: string, value: (r: HistoryRecord) => boolean): Split {
  return { signal, order: ["yes", "no"], bucketOf: (r) => (value(r) ? "yes" : "no") };
}

const SPLITS: Split[] = [
  sized("lines changed", [50, 200, 500, 1000], (r) => r.lines),
  sized("files changed", [3, 8, 20], (r) => r.files),
  yesNo("linked issue", (r) => r.linkedIssue),
  yesNo("docs only", (r) => r.docsOnly),
  yesNo("changes requested", (r) => r.changesRequested),
  yesNo("draft", (r) => r.draft),
  { signal: "ci", bucketOf: (r) => r.checks },
  { signal: "author kind", bucketOf: (r) => r.authorKind },
];

/** Buckets in the split's order, or by size when it has none. */
function rank(split: Split, row: Bucket): number {
  return split.order ? split.order.indexOf(row.bucket) : -(row.merged + row.closed);
}

function bucketsOf(records: HistoryRecord[]): Bucket[] {
  return SPLITS.flatMap(function bucketsFor(split) {
    const counts = new Map<string, Bucket>();
    for (const r of records) {
      const bucket = split.bucketOf(r);
      const row = counts.get(bucket) ?? { signal: split.signal, bucket, merged: 0, closed: 0 };
      row[r.outcome]++;
      counts.set(bucket, row);
    }
    return [...counts.values()].sort((a, b) => rank(split, a) - rank(split, b));
  });
}

/** Pairs each closed pull request with its facts and counts merged against closed on each side of every split. */
export function measure({ repo, closed, items }: History): Measured {
  if (closed.length !== items.length) throw new Error(`history lists ${closed.length} pull requests but read ${items.length}`);
  const records: HistoryRecord[] = [];
  const unread: Measured["unread"] = [];
  for (const [i, pr] of closed.entries()) {
    const item = items[i]!;
    if ("error" in item) unread.push({ number: pr.number, error: item.error });
    else records.push(record(pr, item.facts));
  }
  return { repo, records, unread, buckets: bucketsOf(records) };
}
