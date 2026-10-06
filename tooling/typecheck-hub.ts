// SPDX-License-Identifier: GPL-2.0-only
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const result = Bun.spawnSync(
  ["bunx", "tsc", "--noEmit", "-p", "apps/hub", "--pretty", "false"],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
const output = `${result.stdout.toString()}${result.stderr.toString()}`;
const firstPartyDiagnostics: string[] = [];
let isVendorDiagnostic = false;
for (const line of output.split("\n")) {
  if (line.length === 0) continue;
  if (!/^\s/.test(line)) isVendorDiagnostic = line.startsWith("vendor/");
  if (!isVendorDiagnostic) firstPartyDiagnostics.push(line);
}

if (firstPartyDiagnostics.length > 0) {
  console.error(firstPartyDiagnostics.join("\n"));
  process.exit(1);
}
