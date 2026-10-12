import { RE2JS } from "re2js";

/** `*` matches within a path segment, `**` across segments; everything else is literal. RE2 keeps matching linear. */
export function globMatch(path: string, glob: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) => part.split("*").map(RE2JS.quote).join("[^/]*"))
    .join(".*");
  return RE2JS.matches(pattern, path);
}
