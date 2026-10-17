import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkPolicyFile, notAFileReason, POLICY_FILE_PATHS, type PolicyFileProblem } from "@corbits/triage-contracts";

// Workflow command escaping as in https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function annotation(path: string, problem: PolicyFileProblem): string {
  const where = [`file=${escapeProperty(path)}`];
  if (problem.line !== undefined) where.push(`line=${problem.line}`);
  if (problem.column !== undefined) where.push(`col=${problem.column}`);
  return `::error ${where.join(",")}::${escapeData(problem.message)}`;
}

function main(): void {
  const [root, repo] = process.argv.slice(2);
  if (!root || !repo) throw new Error("Usage: main.ts <repository root> <owner/name>");
  for (const path of POLICY_FILE_PATHS) {
    const stats = statSync(join(root, path), { throwIfNoEntry: false });
    if (stats) {
      check(root, path, stats.isFile(), repo);
      return;
    }
  }
  console.log(`No ${POLICY_FILE_PATHS.join(" or ")} to check.`);
}

function check(root: string, path: string, isFile: boolean, repo: string): void {
  if (!isFile) {
    console.log(annotation(path, { message: notAFileReason(path) }));
    process.exitCode = 1;
    return;
  }
  const checked = checkPolicyFile(readFileSync(join(root, path), "utf8"), repo);
  if (checked.ok) {
    console.log(`${path} is valid.`);
    return;
  }
  for (const problem of checked.problems) console.log(annotation(path, problem));
  process.exitCode = 1;
}

main();
