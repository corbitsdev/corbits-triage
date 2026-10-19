import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { measure as measureHistory, type History, type Measured } from "../logic/history.js";
import { stepJson } from "../logic/step-json.js";

const Input = type({
  repo: "string",
  closed: type({ number: "number.integer", merged: "boolean", closedAt: "string" }).array(),
  items: type({ error: "string" }).or({ facts: "object", pack: "object" }).array(),
});

const Failed = type({ items: type({ error: "string" }).array().atLeastLength(1) });

/** The scan's per pull request records and merged-against-closed counts, from what the facts action read. */
export async function measure(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<Measured> {
  const json = stepJson(input);
  const failed = Failed(json);
  if (!(failed instanceof type.errors)) throw new Error(`measure: the history read failed: ${failed.items[0]!.error}`);
  const parsed = Input(json);
  if (parsed instanceof type.errors) throw new Error(`measure: invalid input: ${parsed.summary}`);
  return measureHistory(parsed as History);
}
