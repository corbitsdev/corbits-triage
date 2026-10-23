// ast-grep is a native module; code-pattern rules are left out here (run-checks.ts), so nothing parses.
export function parse(): never {
  throw new Error("code-pattern rules do not run in the extension");
}
