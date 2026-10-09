function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The request a run's trigger carried: stock stores the trigger mail with the request JSON as inline text of a part (none for a part stored by ref), and callers may also pass the request itself or its JSON. */
export function triggerRequestOf(payload: unknown): Record<string, unknown> | undefined {
  const value = asRecord(parsed(payload));
  if (!value) return undefined;
  if (typeof value["kind"] === "string") return value;
  const parts = value["parts"];
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const request = triggerRequestOf(asRecord(part)?.["text"]);
    if (request) return request;
  }
  return undefined;
}
