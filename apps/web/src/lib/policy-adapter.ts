import { customCheckEnabled, type CheckPack, type CustomCheck, type Do, type VerdictWord } from "@corbits/triage-contracts";
import type { JudgementPatch, JudgementRule, Step } from "./policy-view.ts";

/**
 * Maps today's check pack to the panel's steps and judgement rules and back; only use-policy-view.ts imports it.
 * Stored Dos have no author condition, no merge kind and scores run 0 to 10, so those controls stay disabled until
 * the contract carries them (CL-10611).
 */

export const NOT_YET = "Arrives with CL-10611, which lets the policy store it.";

/** What today's pack can store: no merge Do, no per-step author condition. */
export const STORES = { merge: false, for: false } as const;

const SCORE_LEVELS = Array.from({ length: 11 }, (_, level) => String(level));

function stepOf(item: Do): Step {
  switch (item.kind) {
    case "comment":
      return { do: "comment", for: "anyone", body: item.target.body };
    case "request-review":
      return { do: "request-review", for: "anyone", who: item.target };
    case "assign":
      return { do: "assign", for: "anyone", who: item.target };
    case "labels":
      return { do: "labels", for: "anyone", labels: item.target };
    case "agent":
      return { do: "agent", for: "anyone", agent: item.target };
    case "approve":
    case "request-changes":
    case "close":
      return { do: item.kind, for: "anyone" };
  }
}

/** Not yet validated: the draft holds a step as typed and the panel says what is missing. */
export function doOf(step: Step): Do {
  switch (step.do) {
    case "comment":
      return { kind: "comment", target: { body: step.body } };
    case "request-review":
      return { kind: "request-review", target: step.who };
    case "assign":
      return { kind: "assign", target: step.who };
    case "labels":
      return { kind: "labels", target: step.labels };
    case "agent":
      return { kind: "agent", target: step.agent };
    case "approve":
    case "request-changes":
    case "close":
      return { kind: step.do, target: {} };
    case "merge":
      throw new Error(`Approve and merge: ${NOT_YET}`);
  }
}

export function stepsOf(pack: CheckPack, verdict: VerdictWord): Step[] {
  return pack.actions[verdict].map(stepOf);
}

export function judgementOf(row: CustomCheck): JudgementRule | null {
  if (row.kind !== "model") return null;
  const on = customCheckEnabled(row);
  if (row.shape === "is-true") return { id: row.id, on, shape: "is-true", claim: row.claim };
  if (row.shape === "score") return { id: row.id, on, shape: "score", subject: row.subject, levels: SCORE_LEVELS, ...(row.min > 0 && { failBelow: String(row.min) }) };
  return null;
}

/** The rule's text names it, so the inbox shows the claim or subject; a blank one keeps the name it had. */
function patched(row: CustomCheck, patch: JudgementPatch): CustomCheck {
  if (row.kind !== "model") return row;
  if (row.shape === "is-true" && patch.claim !== undefined) return { ...row, name: patch.claim.trim() || row.name, claim: patch.claim };
  if (row.shape !== "score") return row;
  if (patch.subject !== undefined) return { ...row, name: patch.subject.trim() || row.name, subject: patch.subject };
  if (patch.failBelow !== undefined) return { ...row, min: patch.failBelow === null ? 0 : Number(patch.failBelow) };
  return row;
}

export function patchJudgementRule(pack: CheckPack, id: string, patch: JudgementPatch): CheckPack {
  return { ...pack, custom: pack.custom.map((row) => (row.id === id ? patched(row, patch) : row)) };
}

export const NEW_RULE_NAMES: Record<JudgementRule["shape"], string> = { "is-true": "Is it true", score: "Score" };

/** An empty rule of `shape` under `id`; a pack that already holds `id` is left as it is. */
export function withNewJudgementRule(pack: CheckPack, shape: JudgementRule["shape"], id: string): CheckPack {
  if (pack.custom.some((row) => row.id === id)) return pack;
  const base = { id, name: NEW_RULE_NAMES[shape], group: "pull-request" as const, kind: "model" as const };
  const row: CustomCheck = shape === "is-true" ? { ...base, shape, claim: "" } : { ...base, shape, subject: "", min: 0 };
  return { ...pack, custom: [...pack.custom, row] };
}
