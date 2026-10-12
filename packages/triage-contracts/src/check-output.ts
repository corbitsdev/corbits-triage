import { type } from "arktype";

/**
 * What a check found, beside its pass, fail or unconfirmed result. Values are facts named for what they state
 * (`hasConflicts: true`, `status: "pending"`, `files: 33`). A score is 0 to 100, how likely the check is fine, unrounded,
 * with the bar at which the check passes, the files or hunks behind it and any it could not read. Met, not applicable and
 * could not check are states, never numbers.
 */
export const CheckOutputSchema = type({ kind: "'values'", values: "Record<string, number | boolean | string>" })
  .or({ kind: "'score'", score: "0 <= number <= 100", passAt: "0 <= number <= 100", items: "string[]", "unread?": "string[]" })
  .or({ kind: "'met'", items: "string[]" })
  .or({ kind: "'not-applicable'" })
  .or({ kind: "'could-not-check'", reason: "string", "items?": "string[]" });

export type CheckOutput = typeof CheckOutputSchema.infer;

/** Undefined for a check recorded before checks carried output. */
export function parseCheckOutput(raw: unknown): CheckOutput | undefined {
  const output = CheckOutputSchema(raw);
  return output instanceof type.errors ? undefined : output;
}
