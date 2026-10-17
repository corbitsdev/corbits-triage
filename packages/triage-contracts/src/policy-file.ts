// A repository's policy kept in the repository itself: schema 3 (`rules`, see policy-rules.ts), or the stored policy's
// shape less what the repository already says (`kind`, `schemaVersion` and `repo`). Only YAML is read; another format is another path.
import { dump, JSON_SCHEMA, load, YAMLException } from "js-yaml";
import { asRecord } from "@corbits/common";
import { CATALOG_IDS, CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, readCheckPack, readPolicyOverride } from "./check-pack.js";
import { isPolicyRulesFile, PolicyFileError, policyRulesSchema, rulesToPolicy } from "./policy-rules.js";

export const POLICY_FILE_PATH = ".corbits-triage.yml";
/** Read in this order on the default branch; the first one found is the policy. */
export const POLICY_FILE_PATHS = [POLICY_FILE_PATH, ".corbits-triage.yaml"] as const;
export const POLICY_FILE_MAX_BYTES = 64 * 1024;

/** `line` and `column` count from 1; a problem not tied to one place in the file has neither. */
export type PolicyFileProblem = { message: string; line?: number; column?: number };

export type PolicyFileCheck = { ok: true; policy: Record<string, unknown> } | { ok: false; problems: PolicyFileProblem[] };

const IMPLIED_KEYS = ["kind", "schemaVersion", "repo"] as const;
const PACK_KEYS = ["checks", "custom", "actions", "labels"];
const OVERRIDE_KEYS = ["extends", ...PACK_KEYS];
const NODES_MAX = 10_000;
const DEPTH_MAX = 32;
const TOO_LARGE = "The policy file is too large or uses aliases.";

/** Published as JSON Schema: schema 3, the shape new files are written in. `readPolicyFile` stays the authority and still reads the older shape. */
export const policyFileSchema = policyRulesSchema;

class YamlProblem extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(message);
  }
}

/** The document and the line each mapping and list in it starts on, which is the line of its key. */
function parseYaml(text: string): { root: unknown; lines: WeakMap<object, number> } {
  if (new TextEncoder().encode(text).length > POLICY_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
  const lines = new WeakMap<object, number>();
  const opened: number[] = [];
  function listen(event: "open" | "close", state: { line: number; result: unknown }) {
    if (event === "open") {
      opened.push(state.line + 1);
      return;
    }
    const line = opened.pop();
    if (line !== undefined && state.result !== null && typeof state.result === "object") lines.set(state.result, line);
  }
  try {
    return { root: load(text, { schema: JSON_SCHEMA, listener: listen }), lines };
  } catch (error) {
    if (!(error instanceof YAMLException)) throw error;
    // The full message quotes the file; the reason and position say enough without carrying its content into logs.
    throw new YamlProblem(`The policy file is not YAML: ${error.reason}.`, error.mark.line + 1, error.mark.column + 1);
  }
}

const LISTED_MAX = 5;
const NAME_MAX = 80;

/** Names from the file, cut short so a refusal never carries much of it. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_MAX).map((name) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name)).join(", ");
  return names.length > LISTED_MAX ? `${shown} and ${names.length - LISTED_MAX} more` : shown;
}

/**
 * A loaded document shares an object only through an alias, and a few aliases can expand into billions of nodes once
 * serialised, so any shared object, deep nesting or too many nodes is refused before anything walks it in full.
 */
function refuseExpansion(root: unknown): void {
  const seen = new Set<object>();
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node) || seen.size >= NODES_MAX || depth > DEPTH_MAX) throw new Error(TOO_LARGE);
    seen.add(node);
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
}

function refuseUnknown(file: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(file).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`The policy file has unknown keys: ${listed(unknown)}.`);
  // The stored policy drops a rule id it does not know, which in a file is a typo that leaves the real rule at its default.
  const checks = Object.keys(asRecord(file.checks) ?? {}).filter((id) => !(CATALOG_IDS as readonly string[]).includes(id));
  if (checks.length > 0) throw new Error(`The policy file has unknown checks: ${listed(checks)}.`);
}

function policyOf(file: Record<string, unknown>, repo: string): Record<string, unknown> {
  const header = { kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION } as const;
  const rules = isPolicyRulesFile(file);
  if (!rules) refuseUnknown(file, file.extends === undefined ? PACK_KEYS : OVERRIDE_KEYS);
  const body = rules ? rulesToPolicy(file) : file;
  if (body.extends !== undefined) return { ...header, ...readPolicyOverride({ ...body, ...header, repo }, repo) };
  const { dropped, ...pack } = readCheckPack({ ...body, ...header, repo }, repo);
  if (dropped) throw new Error(`The policy file holds what no longer runs: ${listed(dropped)}.`);
  return pack;
}

/** The line of the innermost mapping or list on `path`, as the document holds it. */
function lineOf(root: Record<string, unknown>, lines: WeakMap<object, number>, path: readonly PropertyKey[]): number | undefined {
  let node: unknown = root;
  let line = lines.get(root);
  for (const key of path) {
    node = (node as Record<PropertyKey, unknown>)[key];
    if (node === null || typeof node !== "object") break;
    line = lines.get(node) ?? line;
  }
  return line;
}

function located(root: Record<string, unknown>, lines: WeakMap<object, number>, { message, path }: PolicyFileError["problems"][number]): PolicyFileProblem {
  const line = lineOf(root, lines, path);
  return line === undefined ? { message } : { message, line };
}

/** The policy the file holds, read and normalised as the hub stores it, or each reason it is refused with where it is in the file. */
export function checkPolicyFile(text: string, repo: string): PolicyFileCheck {
  let parsed: ReturnType<typeof parseYaml>;
  try {
    parsed = parseYaml(text);
    refuseExpansion(parsed.root);
  } catch (error) {
    if (error instanceof YamlProblem) return { ok: false, problems: [{ message: error.message, line: error.line, column: error.column }] };
    if (error instanceof Error) return { ok: false, problems: [{ message: error.message }] };
    throw error;
  }
  const { root, lines } = parsed;
  const file = asRecord(root);
  if (!file) return { ok: false, problems: [{ message: "The policy file must be a mapping." }] };
  try {
    return { ok: true, policy: policyOf(file, repo) };
  } catch (error) {
    if (error instanceof PolicyFileError) return { ok: false, problems: error.problems.map((problem) => located(file, lines, problem)) };
    if (error instanceof Error) return { ok: false, problems: [{ message: error.message }] };
    throw error;
  }
}

/** One problem per line, each led by where it is. */
export function policyFileReason(problems: readonly PolicyFileProblem[]): string {
  return problems.map((problem) => (problem.line === undefined ? problem.message : `Line ${problem.line}: ${problem.message}`)).join("\n");
}

/** The policy the file holds; throws an Error whose message says why the file is refused. */
export function readPolicyFile(text: string, repo: string): Record<string, unknown> {
  const checked = checkPolicyFile(text, repo);
  if (!checked.ok) throw new Error(policyFileReason(checked.problems));
  return checked.policy;
}

/** The file for a stored policy. Repositories can be public, so it names nothing about the hub that wrote it. */
export function policyFileText(stored: Record<string, unknown>): string {
  const body = Object.fromEntries(Object.entries(stored).filter(([key]) => !(IMPLIED_KEYS as readonly string[]).includes(key) && key !== "dropped"));
  return `# Corbits Triage policy.\n${dump(body, { schema: JSON_SCHEMA, lineWidth: -1 })}`;
}
