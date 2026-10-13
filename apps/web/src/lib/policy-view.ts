import type { AgentTarget, LabelsTarget, PeopleTarget, ReviewTarget } from "@corbits/triage-contracts";

/** What a step does. A verdict with no steps does nothing. */
export const STEP_DOS = ["approve", "merge", "close", "comment", "request-changes", "request-review", "assign", "labels"] as const;
export type StepDo = (typeof STEP_DOS)[number];

export const STEP_DO_NAMES: Record<StepDo | "agent", string> = {
  approve: "Approve",
  merge: "Approve and merge",
  close: "Close",
  comment: "Comment",
  "request-changes": "Request changes",
  "request-review": "Request review from…",
  assign: "Assign to…",
  labels: "Add label…",
  agent: "Run an agent",
};

/** Whose pull requests a step applies to. */
export type StepFor = "anyone" | "first-timers" | "maintainers" | "external" | "bots" | { team: string } | { users: string[] };

export const FOR_NAMES = {
  anyone: "anyone",
  "first-timers": "first-timers",
  maintainers: "maintainers",
  external: "external contributors",
  bots: "bots",
  team: "a GitHub team…",
  users: "specific people…",
} as const;

/** `agent` steps are no longer offered; one already stored stays as it is. */
export type Step = { for: StepFor } & (
  | { do: "approve" | "merge" | "close" | "request-changes" }
  | { do: "comment"; body: string }
  | { do: "request-review"; who: ReviewTarget }
  | { do: "assign"; who: PeopleTarget }
  | { do: "labels"; labels: LabelsTarget }
  | { do: "agent"; agent: AgentTarget }
);

/** A decision-model rule the repository adds: a yes or no claim, or a score over described levels. */
export type JudgementRule = { id: string; on: boolean } & (
  | { shape: "is-true"; claim: string }
  | { shape: "score"; subject: string; levels: string[]; failBelow?: string }
);

/** One field of a judgement rule; `failBelow: null` means it never fails. */
export type JudgementPatch = { claim?: string; subject?: string; failBelow?: string | null };

/** A step after its Do changes: keeps who it is for and starts the new Do's values empty. */
export function freshStep(step: Step, next: StepDo): Step {
  switch (next) {
    case "comment":
      return { do: next, for: step.for, body: "" };
    case "request-review":
      return { do: next, for: step.for, who: { to: "codeowners" } };
    case "assign":
      return { do: next, for: step.for, who: { to: "users", users: [] } };
    case "labels":
      return { do: next, for: step.for, labels: { from: "list", labels: [] } };
    default:
      return { do: next, for: step.for };
  }
}
