import { PRIORITIES, TRIAGE_STATES, type Priority, type WorkflowState } from "@corbits/triage-contracts";

export { TRIAGE_STATES, PRIORITIES };
export type TriageState = WorkflowState;
export type { Priority };

export interface Preset {
  labels: string[];
  feedback: string;
  owner: string;
  nextAction: string;
}

export const PRESETS: Record<TriageState, Preset> = {
  "needs-decision": {
    labels: ["triage:needs-decision"],
    feedback: "Thanks @{author}. A maintainer needs to decide on this one: {reason}.",
    owner: "Maintainer",
    nextAction: "Review the evidence and decide",
  },
  "awaiting-review": {
    labels: ["triage:awaiting-review"],
    feedback: "Thanks @{author}. This is waiting on a reviewer: {reason}.",
    owner: "Reviewer / Maintainer",
    nextAction: "Assign and complete a review",
  },
  "needs-author-update": {
    labels: ["triage:needs-author-update"],
    feedback: "Thanks @{author}. Please update this pull request: {reason}.",
    owner: "Author",
    nextAction: "Update the pull request",
  },
  blocked: {
    labels: ["triage:blocked"],
    feedback: "Thanks @{author}. This is blocked: {reason}.",
    owner: "Author",
    nextAction: "Resolve the failing evidence",
  },
  "ready-monitoring": {
    labels: ["triage:ready"],
    feedback: "Thanks @{author}. No blockers found. Ready for maintainer review.",
    owner: "Maintainer",
    nextAction: "Monitor for new evidence",
  },
  "stale-unknown": {
    labels: ["triage:stale-unknown"],
    feedback: "Thanks @{author}. Triage could not be completed: {reason}. Rechecking.",
    owner: "system",
    nextAction: "Retry when data is available",
  },
};

export const DUPLICATE_NEXT_ACTION = "Confirm duplicate or withdraw";

export interface Rendered {
  state: TriageState;
  priority: Priority;
  labels: string[];
  feedback: string;
  owner: string;
  nextAction: string;
  humanGated: boolean;
}

export function render(
  state: TriageState,
  ctx: { author: string; reason: string; priority?: Priority; humanGated?: boolean; duplicate?: boolean },
): Rendered {
  const p = PRESETS[state];
  return {
    state,
    priority: ctx.priority ?? priorityFor(state),
    labels: [...p.labels],
    feedback: p.feedback.replace(/\{author\}|\{reason\}/g, (s) => (s === "{author}" ? ctx.author : ctx.reason)),
    owner: p.owner,
    nextAction: ctx.duplicate ? DUPLICATE_NEXT_ACTION : p.nextAction,
    humanGated: ctx.humanGated ?? state === "needs-decision",
  };
}

export function priorityFor(state: TriageState): Priority {
  switch (state) {
    case "needs-decision": return "P1";
    case "blocked": return "P2";
    case "awaiting-review": return "P2";
    default: return "P3";
  }
}
