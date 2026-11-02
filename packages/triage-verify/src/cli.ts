import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { asRepo } from "@corbits/common";
import { checkPolicyFile, notAFileReason, policyFileReason } from "@corbits/triage-contracts";

const USAGE = `Usage: triage-verify [--owner <owner>] [--name <name>] <policy-file>

Checks a policy file the way Corbits Triage reads it.
\`extends\` is not resolved: a parent policy is not loaded.
--owner and --name are optional and must be passed together.
When they are omitted, the file is read as owner/name.`;

const DEFAULT_REPO = "owner/name";

function usage(code: number): void {
  if (code === 0) console.log(USAGE);
  else console.error(USAGE);
  process.exitCode = code;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function check(path: string, repo: string): void {
  let text: string;
  try {
    if (!statSync(path).isFile()) {
      console.error(notAFileReason(path));
      process.exitCode = 1;
      return;
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      console.error(`No such file: ${path}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const checked = checkPolicyFile(text, repo);
  if (!checked.ok) {
    console.error(policyFileReason(checked.problems));
    process.exitCode = 1;
    return;
  }
  if (checked.pending === undefined) return;
  for (const line of policyFileReason(checked.pending).split("\n")) console.error(`warning: ${line}`);
}

function main(): void {
  let positionals: string[];
  let owner: string | undefined;
  let name: string | undefined;
  let help = false;
  try {
    const parsed = parseArgs({
      options: {
        owner: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
    positionals = parsed.positionals;
    owner = parsed.values.owner;
    name = parsed.values.name;
    help = parsed.values.help === true;
  } catch {
    usage(2);
    return;
  }
  if (help && positionals.length === 0 && owner === undefined && name === undefined) {
    usage(0);
    return;
  }
  const path = positionals.length === 1 ? positionals[0] : undefined;
  const paired = (owner === undefined) === (name === undefined);
  if (path === undefined || !paired) {
    usage(2);
    return;
  }
  const repo = asRepo(owner !== undefined && name !== undefined ? `${owner}/${name}` : DEFAULT_REPO);
  if (repo === undefined) {
    console.error("Repository must be owner/name.");
    process.exitCode = 2;
    return;
  }
  check(path, repo);
}

main();
