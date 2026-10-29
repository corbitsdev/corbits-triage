export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Rejects values that could traverse paths. */
export function asRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) return undefined;
  if (parts.some((part) => part === "." || part === "..") || trimmed.includes("..") || /[\s\\]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** Code-unit order, unlike `localeCompare`, so sorted output is the same on every machine. */
export function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
