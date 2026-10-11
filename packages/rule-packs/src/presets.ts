import { PRIORITIES, TRIAGE_STATES, type Priority, type WorkflowState } from "@corbits/triage-contracts";

export { TRIAGE_STATES, PRIORITIES };
export type TriageState = WorkflowState;
export type { Priority };

export interface Preset {
  labels: string[];
  owner: string;
}

const NEEDS_CHANGES = "Triage: Needs changes";
const NEEDS_REVIEW = "Triage: Needs review";
const READY_TO_MERGE = "Triage: Ready to merge";

export const PRESETS: Record<TriageState, Preset> = {
  "needs-decision": { labels: [NEEDS_REVIEW], owner: "Maintainer" },
  "awaiting-review": { labels: [NEEDS_REVIEW], owner: "Reviewer / Maintainer" },
  "needs-author-update": { labels: [NEEDS_CHANGES], owner: "Author" },
  blocked: { labels: [NEEDS_CHANGES], owner: "Author" },
  "ready-monitoring": { labels: [READY_TO_MERGE], owner: "Maintainer" },
  "stale-unknown": { labels: [NEEDS_REVIEW], owner: "system" },
};

// Labels earlier versions set; owning them clears them from a pull request the next time it is triaged.
const RETIRED_LABELS = [
  "triage:needs-decision",
  "triage:awaiting-review",
  "triage:needs-author-update",
  "triage:blocked",
  "triage:ready",
  "triage:stale-unknown",
];

/** Every label a verdict state can set, and every label it once set; the mirror removes only these. */
export const TRIAGE_LABELS: readonly string[] = [...new Set([...Object.values(PRESETS).flatMap((preset) => preset.labels), ...RETIRED_LABELS])];

export interface Rendered {
  state: TriageState;
  priority: Priority;
  labels: string[];
  owner: string;
  humanGated: boolean;
}

export function render(state: TriageState, ctx: { priority?: Priority; humanGated?: boolean } = {}): Rendered {
  const p = PRESETS[state];
  return {
    state,
    priority: ctx.priority ?? priorityFor(state),
    labels: [...p.labels],
    owner: p.owner,
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
