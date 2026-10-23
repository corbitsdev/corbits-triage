#!/usr/bin/env -S bun --conditions=intx-src
import { parseArgs } from "node:util";
import { checkPolicyFile, policyFileReason } from "@corbits/triage-contracts";
import { runChecks, type Failure, type Report } from "./checks.js";
import { basePolicy, defaultBase, hostOnly, LOCAL_NUMBER, localGithub, readChange, repositoryRoot, type LocalChange } from "./local-git.js";

const USAGE = "Usage: corbits-triage check [--base <ref>]";

function line({ title, error, text }: Failure): string {
  return `${error ? "error" : "warning"}${title === undefined ? "" : ` ${title}`}: ${text}`;
}

/**
 * Runs the base policy's rules on the commits since the base, as triage sees them once pushed, then on the working tree
 * when it differs. The exit code follows the commits: 1 when a rule whose failure means Fail fails, 2 when nothing could be judged.
 */
async function check(base: string | undefined): Promise<number> {
  const root = repositoryRoot(process.cwd());
  const ref = base ?? defaultBase(root);
  const file = basePolicy(root, ref);
  if (!file) {
    console.log(`${ref} has no policy, so no rules ran.`);
    return 0;
  }
  const committed = readChange(root, ref, false);
  const working = readChange(root, ref, true);
  const checked = checkPolicyFile(file.text, committed.repo);
  if (!checked.ok) {
    console.error(`${file.path} on ${ref} cannot be read:\n${policyFileReason(checked.problems)}`);
    return 2;
  }
  if (checked.policy.extends !== undefined) {
    console.error(`${file.path} on ${ref} extends another policy, which is not read locally.`);
    return 2;
  }
  const policy = checked.policy;
  async function report(name: string, change: LocalChange): Promise<Report> {
    const result = await runChecks(policy, { repo: change.repo, number: LOCAL_NUMBER, headSha: change.headSha }, localGithub(change), hostOnly);
    if (result.writes.length > 0) throw new Error(`pr-triage tried to write to the host: ${result.writes.map(({ method, path }) => `${method} ${path}`).join(", ")}`);
    console.log(`# ${name}\n\n${result.summary.join("\n")}`);
    for (const failure of result.failures) console.log(line(failure));
    return result;
  }
  const pushed = await report("Committed", committed);
  console.log("");
  if (Bun.deepEquals(working.files, committed.files)) {
    console.log("# Working tree\n\nNo uncommitted changes.");
  } else {
    const local = await report("Working tree", working);
    if ((local.failed || local.unread) && !pushed.failed && !pushed.unread) console.log("warning: the working tree fails where the commits pass; committing it would fail.");
  }
  if (pushed.unread) return 2;
  return pushed.failed ? 1 : 0;
}

async function main(): Promise<void> {
  try {
    const { positionals, values } = parseArgs({ options: { base: { type: "string" } }, allowPositionals: true });
    if (positionals.length !== 1 || positionals[0] !== "check") throw new Error(USAGE);
    process.exitCode = await check(values.base);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

await main();
