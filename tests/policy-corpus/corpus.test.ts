import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { parse } from "yaml";
import { checkPolicyFile, POLICY_FILE_PATH, policyFileReason, type RepoSource } from "@corbits/triage-contracts";
import { textRefusal } from "../../apps/hub/src/github/policy-file.ts";
import { fileRefusal, previewRepoPolicy, type RepoPolicyDeps } from "../../apps/hub/src/github/repo-policy.ts";
import { Failure } from "../../apps/hub/src/route-schema.ts";

const FILES = join(import.meta.dir, "files");
const ACTION = join(import.meta.dir, "../../packages/policy-check-action/src/main.ts");
const REPO = "acme/widgets";
const TENANT = "tenant";

const outcome = { accept: "boolean", "reason?": "string", "pending?": "string" } as const;
const Outcome = type({ "+": "reject", ...outcome });
type Outcome = typeof Outcome.infer;

/**
 * `checkPolicyFile` the shared read; `action` the policy-check Action's lint; `hubRead` the policy the hub runs triage on;
 * `hubWrite` the hub's refusal of text the portal saves, pushes or opens a pull request with.
 */
const READERS = ["checkPolicyFile", "action", "hubRead", "hubWrite"] as const;
type ReaderName = (typeof READERS)[number];

/** `seams` is where a reader answers otherwise by design; every other reader answers `accept`, `reason` and `pending`. */
const Expected = type({ "+": "reject", ...outcome, "seams?": type({ "+": "reject", "action?": Outcome, "checkPolicyFile?": Outcome, "hubRead?": Outcome, "hubWrite?": Outcome }) });

const hubDeps: RepoPolicyDeps = {
  async policyFile() {
    throw new Error("The corpus holds no other repository's policy.");
  },
  async automaticKinds() {
    return [];
  },
};

function fromAnnotation(line: string): string {
  const [, at, message] = /^::\w+ (.*?)::(.*)$/.exec(line)!;
  const text = message!.replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%");
  const fileLine = /(?:^|,)line=(\d+)/.exec(at!)?.[1];
  return fileLine === undefined ? text : `Line ${fileLine}: ${text}`;
}

function annotations(lines: string[], level: "error" | "warning"): string | undefined {
  const found = lines.filter((line) => line.startsWith(`::${level} `)).map(fromAnnotation);
  return found.length === 0 ? undefined : found.join("\n");
}

/** The Action as CI runs it on a checkout holding `text`: its exit code, and its annotations read back as the hub words them. */
function action(text: string): Outcome {
  const root = mkdtempSync(join(tmpdir(), "policy-corpus-"));
  writeFileSync(join(root, POLICY_FILE_PATH), text);
  const run = Bun.spawnSync([process.execPath, "--conditions=intx-src", ACTION, root, REPO], { env: {} });
  const lines = run.stdout.toString().split("\n");
  return { accept: run.exitCode === 0, reason: annotations(lines, "error"), pending: annotations(lines, "warning") };
}

async function refusal(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>): Promise<string | undefined> {
  return fileRefusal(hubDeps, tenantId, repo, source, policy);
}

async function readers(text: string): Promise<Record<ReaderName, Outcome>> {
  const checked = checkPolicyFile(text, REPO);
  const read = await previewRepoPolicy(hubDeps, TENANT, REPO, "github", text);
  const refused = await textRefusal(refusal, TENANT, { name: REPO, connected: true }, text);
  return {
    checkPolicyFile: checked.ok ? { accept: true, pending: checked.pending && policyFileReason(checked.pending) } : { accept: false, reason: policyFileReason(checked.problems) },
    action: action(text),
    hubRead: read.status === "invalid" ? { accept: false, reason: read.reason } : { accept: read.status === "ok" },
    hubWrite: refused ? { accept: false, reason: Failure.assert(await refused.json()).error.message } : { accept: true },
  };
}

/** Readers that name what they skip report `pending`; the others only accept or refuse. */
const REPORTS_PENDING: Record<ReaderName, boolean> = { checkPolicyFile: true, action: true, hubRead: false, hubWrite: false };

function wanted({ accept, reason, pending }: Outcome, reader: ReaderName) {
  return {
    accept,
    reason: reason === undefined ? undefined : expect.stringContaining(reason),
    ...(REPORTS_PENDING[reader] && { pending: pending === undefined ? undefined : expect.stringContaining(pending) }),
  };
}

const policies = readdirSync(FILES).filter((name) => !name.endsWith(".expect.yml"));

test.each(policies)("every reader answers %s as expected", async (name) => {
  const { seams, ...expected } = Expected.assert(parse(readFileSync(join(FILES, name.replace(/\.yml$/, ".expect.yml")), "utf8")));
  const observed = await readers(readFileSync(join(FILES, name), "utf8"));
  expect(READERS.map((reader) => [reader, observed[reader]])).toEqual(READERS.map((reader) => [reader, wanted(seams?.[reader] ?? expected, reader)]));
}, 15_000);
