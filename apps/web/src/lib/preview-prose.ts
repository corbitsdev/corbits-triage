import type { CheckPack } from "@corbits/triage-contracts";
import { strings, type PreviewCheck, type PreviewBranch, type PreviewDo, type PullPreview } from "./hub-api.ts";
import { actionLabel, BRANCH_NAMES, DO_NAMES, listed, quoted, sentence } from "./pack-prose.ts";

export type CheckLine = { result: PreviewCheck["result"]; label: string; names: string[] };

export type BranchLine = { branch: string; reason: string; dos: string };

export type ActionLine =
  | { id: string; label: string; status: "decided"; branch: BranchLine }
  | { id: string; label: string; status: "waits-on-judge"; branches: BranchLine[] }
  | { id: string; label: string; status: "skipped"; reason: string };

export type PreviewProse = {
  checks: CheckLine[];
  actions: ActionLine[];
  /** The actions the event does not wake, as one sentence. */
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
  const target = step.target ?? {};
  const text = resolvedAction(step, target, repo);
  return step.automatic ? `${text} automatically` : text;
}

function resolvedAction(step: PreviewDo, target: Record<string, unknown>, repo: string): string {
  switch (step.kind) {
    case "labels": {
      if (target.unresolved === "derive") return `label it by ${String(target.from)}`;
      const labels = strings(target.labels);
      return `add ${labels.length === 1 ? "the label" : "the labels"} ${listed(labels, "and")}`;
    }
    case "assign":
      return `assign ${people(target, repo)}`;
    case "request-review":
      return `request review from ${people(target, repo)}`;
    case "comment":
      return `comment ${quoted(String(target.body))}`;
    case "close":
      return "close it";
    case "agent":
      return `ask an agent ${quoted(String(target.prompt))}`;
  }
}

function branchLine(branch: PreviewBranch, repo: string): BranchLine {
  const dos = branch.dos.length ? sentence(branch.dos.map((step) => resolvedDoText(step, repo)).join(", then ")) : "nothing to do.";
  return { branch: BRANCH_NAMES[branch.branch], reason: branch.reason, dos };
}

/** A preview response in the panel's prose, actions named by their place in the pack that was previewed. */
export function previewProse(preview: PullPreview, pack: CheckPack): PreviewProse {
  const checks = CHECK_LABELS.flatMap(function line([result, text]): CheckLine[] {
    const names = preview.checks.filter((row) => row.result === result).map((row) => row.name);
    return names.length ? [{ result, label: text, names }] : [];
  });
  const actions: ActionLine[] = [];
  const asleep: string[] = [];
  for (const action of preview.actions) {
    switch (action.status) {
      case "not-woken":
        asleep.push(actionLabel(pack, action.id));
        break;
      case "skipped":
        actions.push({ id: action.id, label: actionLabel(pack, action.id), status: "skipped", reason: action.reason });
        break;
      case "decided":
        actions.push({ id: action.id, label: actionLabel(pack, action.id), status: "decided", branch: branchLine(action, preview.repo) });
        break;
      case "waits-on-judge":
        actions.push({ id: action.id, label: actionLabel(pack, action.id), status: "waits-on-judge", branches: action.branches.map((branch) => branchLine(branch, preview.repo)) });
        break;
    }
  }
  const notWoken = asleep.length ? `${listed(asleep, "and")} ${asleep.length === 1 ? "does" : "do"} not run on this event.` : null;
  const { degraded, reason, feedback } = preview.verdict;
  return { checks, actions, notWoken, degraded: degraded === null ? null : reason, comment: feedback.trim() ? feedback : null };
}
