import { VERDICTS, verdictLabel } from "./check-pack.js";
import type { Priority, WorkflowState } from "./types.js";

const OWNERS: Record<WorkflowState, string> = {
  "needs-decision": "Maintainer",
  "awaiting-review": "Reviewer / Maintainer",
  "needs-author-update": "Author",
  blocked: "Author",
  "ready-monitoring": "Maintainer",
  "stale-unknown": "system",
};

// Labels earlier versions set; owning them clears them from a pull request the next time it is triaged.
const RETIRED_LABELS = [
  "Triage: Needs changes",
  "Triage: Needs review",
  "Triage: Ready to merge",
  "triage:needs-decision",
  "triage:awaiting-review",
  "triage:needs-author-update",
  "triage:blocked",
  "triage:ready",
  "triage:stale-unknown",
];

/** Every verdict label, and every label triage once set; the mirror removes only these. */
export const TRIAGE_LABELS: readonly string[] = [...VERDICTS.map(verdictLabel), ...RETIRED_LABELS];

export interface Rendered {
  state: WorkflowState;
  priority: Priority;
  owner: string;
  humanGated: boolean;
}

export function render(state: WorkflowState, ctx: { priority?: Priority; humanGated?: boolean } = {}): Rendered {
  return {
    state,
    priority: ctx.priority ?? priorityFor(state),
    owner: OWNERS[state],
    humanGated: ctx.humanGated ?? state === "needs-decision",
  };
}

function priorityFor(state: WorkflowState): Priority {
  switch (state) {
    case "needs-decision": return "P1";
    case "blocked": return "P2";
    case "awaiting-review": return "P2";
    default: return "P3";
  }
}
