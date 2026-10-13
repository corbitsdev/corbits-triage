import { strings, type PreviewCheck, type PreviewDo, type PreviewList, type PullPreview } from "./hub-api.ts";
import { DO_NAMES, LIST_NAMES, listed, quoted, sentence } from "./pack-prose.ts";
import { checkValueText, VERDICT_LABEL } from "./triage-view.ts";

type CheckLine = { result: PreviewCheck["result"]; label: string; names: string[] };

export type ListLine = { list: string; dos: string };

export type PreviewProse = {
  checks: CheckLine[];
  /** The verdict in words, or that it waits on the judge. */
  verdict: string;
  /** The verdict's list, or every list while the verdict waits on the judge; empty when the event does not wake the policy. */
  lists: ListLine[];
  /** Why no Dos run, when the event does not wake the policy. */
  notWoken: string | null;
  /** Why the verdict is degraded, when it is; a degraded verdict suggests no Dos. */
  degraded: string | null;
  comment: string | null;
};

const CHECK_LABELS: Array<[PreviewCheck["result"], string]> = [
  ["pass", "Passed"],
  ["fail", "Failed"],
  ["unconfirmed", "Not confirmed"],
  ["needs-judge", "Needs the judge"],
];

function people(target: Record<string, unknown>, repo: string): string {
  if (target.unresolved === "codeowners") return "CODEOWNERS";
  const owner = repo.split("/", 1)[0];
  return listed([...strings(target.users).map((user) => `@${user}`), ...strings(target.teams).map((slug) => `@${owner}/${slug}`)], "and");
}

/** A Do as the hub resolved it: roles are people by now, and Dos already true on the pull request are left out. */
function resolvedDoText(step: PreviewDo, repo: string): string {
  if (step.skipped) return `skip ${DO_NAMES[step.kind].toLowerCase()} (${step.reason.replace(/\.$/, "")})`;
  return resolvedAction(step, step.target ?? {}, repo);
}

function resolvedAction(step: PreviewDo, target: Record<string, unknown>, repo: string): string {
  switch (step.kind) {
    case "labels": {
      const labels = strings(target.labels);
      return `add ${labels.length === 1 ? "the label" : "the labels"} ${listed(labels, "and")}`;
    }
    case "assign":
      return `assign ${people(target, repo)}`;
    case "request-review":
      return `request review from ${people(target, repo)}`;
    case "comment":
      return `comment ${quoted(String(target.body))}`;
    case "approve":
      return "approve the pull request";
    case "request-changes":
      return "request changes on the pull request";
    case "close":
      return "close it";
    case "merge":
      return "merge it";
  }
}

function listLine(list: PreviewList, repo: string): ListLine {
  const dos = list.dos.length ? sentence(list.dos.map((step) => resolvedDoText(step, repo)).join(", then ")) : "nothing to do.";
  return { list: LIST_NAMES[list.verdict], dos };
}

/** The judge never runs in a preview, so a check waiting on it has no value to show. */
function nameWithValue(row: PreviewCheck): string {
  const value = row.result === "needs-judge" ? null : checkValueText(row);
  return value === null ? row.name : `${row.name} (${value})`;
}

/** A preview response in the panel's prose. */
export function previewProse(preview: PullPreview): PreviewProse {
  const checks = CHECK_LABELS.flatMap(function line([result, text]): CheckLine[] {
    const names = preview.checks.filter((row) => row.result === result).map(nameWithValue);
    return names.length ? [{ result, label: text, names }] : [];
  });
  const { actions } = preview;
  const { degraded, reason, feedback, verdict: word, reasons } = preview.verdict;
  const waits = actions.status === "waits-on-judge";
  const verdict = waits ? "The verdict waits on the judge." : sentence(`${VERDICT_LABEL[word]}: ${reasons[0] ?? reason}`);
  const lists = actions.status === "not-woken" ? [] : waits ? actions.lists.map((list) => listLine(list, preview.repo)) : [listLine(actions, preview.repo)];
  const notWoken = actions.status === "not-woken" ? `This event does not wake the policy's actions.` : null;
  return { checks, verdict, lists, notWoken, degraded: degraded === null ? null : reason, comment: feedback.trim() ? feedback : null };
}
