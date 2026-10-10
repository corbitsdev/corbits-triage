import { isRecord, parseJsonText } from "./extract.js";

/** A step() output is `{ reply, turn }` with the JSON in `reply`; an action output is the object itself. */
export function stepJson(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;
  if (!Object.hasOwn(output, "reply")) return output;
  const reply = typeof output.reply === "string" ? parseJsonText(output.reply) : output.reply;
  return isRecord(reply) ? reply : undefined;
}
