import { PRIORITIES, TRIAGE_STATES, type Priority, type WorkflowState } from "@corbits/triage-contracts";

export { TRIAGE_STATES, PRIORITIES };
export type TriageState = WorkflowState;
export type { Priority };

export interface Preset {
  labels: string[];
  owner: string;
}

export const PRESETS: Record<TriageState, Preset> = {
  "needs-decision": { labels: ["triage:needs-decision"], owner: "Maintainer" },
  "awaiting-review": { labels: ["triage:awaiting-review"], owner: "Reviewer / Maintainer" },
  "needs-author-update": { labels: ["triage:needs-author-update"], owner: "Author" },
  blocked: { labels: ["triage:blocked"], owner: "Author" },
  "ready-monitoring": { labels: ["triage:ready"], owner: "Maintainer" },
  "stale-unknown": { labels: ["triage:stale-unknown"], owner: "system" },
};

/** Every label a verdict state can set; the mirror removes only these. */
export const TRIAGE_LABELS: readonly string[] = Object.values(PRESETS).flatMap((preset) => preset.labels);

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
