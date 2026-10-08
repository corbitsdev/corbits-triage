import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { SONNER_STYLE_HASHES } from "./security-headers.ts";

function styleHash(css: string): string {
  return `'sha256-${createHash("sha256").update(css).digest("base64")}'`;
}

function sonnerImportEntry(): string {
  const packageJsonPath = createRequire(import.meta.url).resolve("sonner/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return join(dirname(packageJsonPath), packageJson.exports["."].import.default);
}

test("the CSP allows exactly the styles the installed sonner injects", () => {
  const bundle = readFileSync(sonnerImportEntry(), "utf8");
  const literals = [...bundle.matchAll(/__insertCSS\(("(?:[^"\\]|\\.)*")\)/g)].map((match) => match[1]);
  if (literals.length === 0) throw new Error("sonner no longer injects its stylesheet through __insertCSS");
  const injected = literals.map((literal) => styleHash(runInNewContext(literal)));
  expect(new Set(SONNER_STYLE_HASHES)).toEqual(new Set([styleHash(""), ...injected]));
});
