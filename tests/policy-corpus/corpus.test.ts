import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { parse } from "yaml";
import { asRecord } from "@corbits/common";
import { checkPolicyFile, POLICY_FILE_PATH, policyFileReason, RESERVED_BLOCKS, type PolicyWorkflow, type RepoSource } from "@corbits/triage-contracts";
import { stateOf, textRefusal, type PolicyFileState } from "../../apps/hub/src/github/policy-file.ts";
import { fileRefusal, readRepoPolicy, type RepoPolicyDeps } from "../../apps/hub/src/github/repo-policy.ts";
import { Failure } from "../../apps/hub/src/route-schema.ts";

const FILES = join(import.meta.dir, "files");
const ACTION = join(import.meta.dir, "../../packages/policy-check-action/src/main.ts");
const REPO = "acme/widgets";
const TENANT = "tenant";

const outcome = { accept: "boolean", "reason?": "string", "pending?": "string" } as const;
const Outcome = type({ "+": "reject", ...outcome });
type Outcome = typeof Outcome.infer;
/** `reserved` is what of a reserved block the policy triage runs on still holds; it must hold none. */
type Observed = Outcome & { reserved?: string[] };

/**
 * `checkPolicyFile` the shared read; `action` the policy-check Action's lint; `hubRead` the policy the hub runs triage on;
 * `hubWrite` the hub's refusal of text the portal saves, pushes or opens a pull request with.
 */
const READERS = ["checkPolicyFile", "action", "hubRead", "hubWrite"] as const;
type ReaderName = (typeof READERS)[number];

/** Whether a reader names what it skips (`pending`), and whether it hands back the policy triage runs on (`runs`). */
const REPORTS: Record<ReaderName, { pending: boolean; runs: boolean }> = {
  checkPolicyFile: { pending: true, runs: true },
  action: { pending: true, runs: false },
  hubRead: { pending: true, runs: true },
  hubWrite: { pending: false, runs: false },
};

/** `seams` is where a reader answers otherwise by design; every other reader answers `accept`, `reason` and `pending`. */
const Expected = type({ "+": "reject", ...outcome, "seams?": type({ "+": "reject", "action?": Outcome, "checkPolicyFile?": Outcome, "hubRead?": Outcome, "hubWrite?": Outcome }) });

function hubDeps(state: PolicyFileState): RepoPolicyDeps {
  return {
    async policyFile(tenantId, repo) {
      if (tenantId !== TENANT || repo !== REPO) throw new Error(`The corpus holds no policy for ${repo}.`);
      return state;
    },
    async automaticKinds() {
      return [];
    },
  };
}

function reservedIn(workflow: PolicyWorkflow): string[] {
  const blocks = RESERVED_BLOCKS.filter((kind) => Object.hasOwn(workflow, kind));
  const conditions = (workflow.decide ?? []).flatMap((rule, at) => RESERVED_BLOCKS.filter((kind) => Object.hasOwn(asRecord(rule.if) ?? {}, kind)).map((kind) => `decide[${at}].if.${kind}`));
  return [...blocks, ...conditions];
}

function fromAnnotation(line: string): string {
  const parts = /^::\w+ (.*?)::(.*)$/.exec(line);
  if (!parts) throw new Error(`The Action printed an annotation it could not have written: ${line}`);
  const [, at = "", message = ""] = parts;
  const text = message.replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%");
  const fileLine = /(?:^|,)line=(\d+)/.exec(at)?.[1];
  return fileLine === undefined ? text : `Line ${fileLine}: ${text}`;
}

function annotations(lines: string[], level: "error" | "warning"): string | undefined {
  const found = lines.filter((line) => line.startsWith(`::${level} `)).map(fromAnnotation);
  return found.length === 0 ? undefined : found.join("\n");
}

/** The Action as CI runs it on a checkout holding `text`: its exit code, and its annotations read back as the hub words them. */
function action(text: string): Observed {
  const root = mkdtempSync(join(tmpdir(), "policy-corpus-"));
  try {
    writeFileSync(join(root, POLICY_FILE_PATH), text);
    const run = Bun.spawnSync([process.execPath, "--conditions=intx-src", ACTION, root, REPO], { env: {}, timeout: 10_000 });
    const lines = run.stdout.toString().split("\n");
    return { accept: run.exitCode === 0, reason: annotations(lines, "error"), pending: annotations(lines, "warning") };
  } finally {
    rmSync(root, { recursive: true });
  }
}

/** The file as the hub reads it from the default branch, resolved as triage runs it. */
async function hubRead(state: PolicyFileState): Promise<Observed> {
  const read = await readRepoPolicy(hubDeps(state), TENANT, REPO, "github");
  if (read.status === "invalid") return { accept: false, reason: read.reason };
  if (state.status !== "ok") throw new Error(`The hub read ${state.status} but resolved ${read.status}.`);
  return { accept: read.status === "ok", pending: state.file.pending, reserved: reservedIn(state.workflow) };
}

async function readers(text: string): Promise<Record<ReaderName, Observed>> {
  const checked = checkPolicyFile(text, REPO);
  const state = stateOf({ path: POLICY_FILE_PATH, read: { kind: "file", sha: "0".repeat(40), text, url: `https://github.com/${REPO}/blob/main/${POLICY_FILE_PATH}` } }, REPO);
  async function refusal(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>): Promise<string | undefined> {
    return fileRefusal(hubDeps(state), tenantId, repo, source, policy);
  }
  const refused = await textRefusal(refusal, TENANT, { name: REPO, connected: true }, text);
  return {
    checkPolicyFile: checked.ok ? { accept: true, pending: checked.pending && policyFileReason(checked.pending), reserved: reservedIn(checked.workflow) } : { accept: false, reason: policyFileReason(checked.problems) },
    action: action(text),
    hubRead: await hubRead(state),
    hubWrite: refused ? { accept: false, reason: Failure.assert(await refused.json()).error.message } : { accept: true },
  };
}

function wanted({ accept, reason, pending }: Outcome, reader: ReaderName): Observed {
  return { accept, reason, ...(REPORTS[reader].pending && { pending }), ...(REPORTS[reader].runs && accept && { reserved: [] }) };
}

const policies = readdirSync(FILES).filter((name) => !name.endsWith(".expect.yml"));

test.each(policies)("every reader answers %s as expected", async (name) => {
  const { seams, ...expected } = Expected.assert(parse(readFileSync(join(FILES, name.replace(/\.yml$/, ".expect.yml")), "utf8")));
  const observed = await readers(readFileSync(join(FILES, name), "utf8"));
  expect(READERS.map((reader) => [reader, observed[reader]])).toEqual(READERS.map((reader) => [reader, wanted(seams?.[reader] ?? expected, reader)]));
}, 15_000);
