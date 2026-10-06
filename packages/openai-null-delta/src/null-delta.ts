// Some OpenAI-compatible backends (glm-5.3-flash via OpenCode; INTR-595) emit
// `delta.role: null` / `delta.tool_calls: null` where stock Interchange expects
// the field absent, and the stock adapter drops those chunks as
// `protocol_mismatch`. This wraps the stock adapter instead of forking vendor.
// Operators opt in per provider via SIDECAR_ADAPTER_MANIFEST, e.g.
// [{provider:"openai-compatible",module:"@corbits/openai-null-delta",export:"createNullTolerantOpenAIAdapter"}].
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { AdapterFactory } from "@intx/inference";

// Widening this list would silently accept wire shapes stock deliberately rejects.
const NULLABLE_DELTA_KEYS = ["role", "tool_calls"] as const;

// Untouched payloads are returned as-is so stock-shaped traffic is never re-serialized
// and unparsable payloads still reach the stock parser's protocol error.
export function normalizeNullDeltaPayload(sseData: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    return sseData;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return sseData;
  }
  const choices: unknown = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return sseData;
  let changed = false;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const delta: unknown = (choice as { delta?: unknown }).delta;
    if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
      continue;
    }
    const fields = delta as Record<string, unknown>;
    for (const key of NULLABLE_DELTA_KEYS) {
      if (fields[key] === null) {
        delete fields[key];
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : sseData;
}

export const createNullTolerantOpenAIAdapter: AdapterFactory = function createNullTolerantOpenAIAdapter(source, quirks) {
  const inner = createOpenAIAdapter(source, quirks);
  return {
    ...inner,
    parseResponse(sseData: string) {
      return inner.parseResponse(normalizeNullDeltaPayload(sseData));
    },
  };
};
