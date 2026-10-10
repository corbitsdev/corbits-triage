export function asText(v: unknown) {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function parseJsonText(text: string, open: "{" | "[" = "{"): unknown {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
