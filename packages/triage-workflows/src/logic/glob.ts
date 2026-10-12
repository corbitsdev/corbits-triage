import { RE2JS } from "re2js";

const COMPILED_MAX = 1000;
const compiled = new Map<string, RE2JS>();

function compile(glob: string): RE2JS {
  const cached = compiled.get(glob);
  if (cached) return cached;
  if (compiled.size >= COMPILED_MAX) compiled.clear();
  const re = RE2JS.compile(
    glob
      .split("**")
      .map((part) => part.split("*").map(RE2JS.quote).join("[^/]*"))
      .join(".*"),
  );
  compiled.set(glob, re);
  return re;
}

/** `*` matches within a path segment, `**` across segments; everything else is literal. RE2 keeps matching linear. */
export function globMatch(path: string, glob: string): boolean {
  return compile(glob).matches(path);
}
