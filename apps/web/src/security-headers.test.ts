import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SONNER_STYLE_HASHES } from "./security-headers.ts";

function styleHash(css: string): string {
  return `'sha256-${createHash("sha256").update(css).digest("base64")}'`;
}

test("the CSP allows exactly the styles the installed sonner injects", async () => {
  const bundle = await Bun.file(fileURLToPath(import.meta.resolve("sonner"))).text();
  const injected = bundle.match(/__insertCSS\(("(?:[^"\\]|\\.)*")\)/);
  if (!injected) throw new Error("sonner no longer injects its stylesheet through __insertCSS");
  expect(SONNER_STYLE_HASHES).toEqual([styleHash(""), styleHash(JSON.parse(injected[1]))]);
});
