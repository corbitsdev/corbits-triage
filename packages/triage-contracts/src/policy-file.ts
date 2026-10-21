// A repository's policy kept in the repository itself: schema 3 (`rules`, see policy-rules.ts) with v4's keys
// (policy-workflow.ts), or the stored policy's shape less what the repository already says (`kind`, `schemaVersion` and
// `repo`). Only YAML is read; another format is another path.
import { isAlias, isMap, isNode, isPair, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node } from "yaml";
import { asRecord } from "@corbits/common";
import { CATALOG_IDS, CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, readCheckPack, readPolicyOverride } from "./check-pack.js";
import { isPolicyRulesFile, PolicyFileError, policyRulesSchema, readRulesFile } from "./policy-rules.js";
import { BLOCK_KINDS, decideOf, type PolicyWorkflow } from "./policy-workflow.js";

export const POLICY_FILE_PATH = ".corbits-triage.yml";
/** Read in this order on the default branch; the first one found is the policy. */
export const POLICY_FILE_PATHS = [POLICY_FILE_PATH, ".corbits-triage.yaml"] as const;
export const POLICY_FILE_MAX_BYTES = 64 * 1024;

/** `line` and `column` count from 1; a problem not tied to one place in the file has neither. */
export type PolicyFileProblem = { message: string; line?: number; column?: number };

/**
 * `workflow` is what the file says beyond the stored policy: its v4 keys, and `decide`, from its schema 3 `actions` when
 * it sets no `decide`. A file that extends another holds no v4 key, so its `workflow` is empty.
 */
export type PolicyFileCheck = { ok: true; policy: Record<string, unknown>; workflow: PolicyWorkflow } | { ok: false; problems: PolicyFileProblem[] };

const PACK_KEYS = ["checks", "custom", "actions", "labels"];
const OVERRIDE_KEYS = ["extends", ...PACK_KEYS];
const TOO_LARGE = "The policy file is too large or uses aliases.";

/** Published as JSON Schema: schema 3, the shape new files are written in. `readPolicyFile` stays the authority and still reads the older shape. */
export const policyFileSchema = policyRulesSchema;

/** A problem at one place in the file, found before it is read as a policy. */
class PlacedProblem extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(message);
  }
}

type Parsed = { root: unknown; doc: Document.Parsed; lines: LineCounter };

/** Keys that would reach an object's prototype once read. */
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

/** Policy files are shallow; anything deeper is refused before it is read. */
const DEPTH_MAX = 32;

function placed(message: string, node: Node, lines: LineCounter): PlacedProblem {
  const { line, col } = lines.linePos(node.range?.[0] ?? 0);
  return new PlacedProblem(message, line, col);
}

/**
 * One walk over the document's nodes, refusing an alias, since a few can expand into billions of nodes, a key that
 * would reach a prototype, and nesting deeper than `DEPTH_MAX`.
 */
function refuseShape(doc: Document.Parsed, lines: LineCounter): void {
  const stack: Array<[unknown, number]> = [[doc.contents, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (isAlias(node)) throw placed(TOO_LARGE, node, lines);
    if (!isMap(node) && !isSeq(node)) continue;
    if (depth > DEPTH_MAX) throw placed(`The policy file nests deeper than ${DEPTH_MAX} levels.`, node, lines);
    for (const item of node.items) {
      if (!isPair(item)) {
        stack.push([item, depth + 1]);
        continue;
      }
      if (isScalar(item.key) && RESERVED_KEYS.includes(String(item.key.value))) throw placed(`\`${String(item.key.value)}\` can't be a key; rename it.`, item.key, lines);
      stack.push([item.key, depth + 1], [item.value, depth + 1]);
    }
  }
}

/** The document's value, with its nodes and where each starts, so a problem can name its line. */
function parseYaml(text: string): Parsed {
  if (new TextEncoder().encode(text).length > POLICY_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
  const lines = new LineCounter();
  // Without pretty errors a message is the reason alone, never quoting the file into logs.
  const doc = parseDocument(text, { schema: "core", lineCounter: lines, prettyErrors: false });
  const error = [...doc.errors, ...doc.warnings][0];
  if (error) {
    const { line, col } = lines.linePos(error.pos[0]);
    throw new PlacedProblem(`The policy file is not YAML: ${error.message.replace(/\.$/, "")}.`, line, col);
  }
  refuseShape(doc, lines);
  return { root: doc.toJS(), doc, lines };
}

const LISTED_MAX = 5;
const NAME_MAX = 80;

/** Names from the file, cut short so a refusal never carries much of it. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_MAX).map((name) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name)).join(", ");
  return names.length > LISTED_MAX ? `${shown} and ${names.length - LISTED_MAX} more` : shown;
}

function refuseUnknown(file: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(file).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`The policy file has unknown keys: ${listed(unknown)}.`);
  // The stored policy drops a rule id it does not know, which in a file is a typo that leaves the real rule at its default.
  const checks = Object.keys(asRecord(file.checks) ?? {}).filter((id) => !(CATALOG_IDS as readonly string[]).includes(id));
  if (checks.length > 0) throw new Error(`The policy file has unknown checks: ${listed(checks)}.`);
}

function readFile(file: Record<string, unknown>): { policy: Record<string, unknown>; workflow: PolicyWorkflow } {
  if (isPolicyRulesFile(file)) return readRulesFile(file);
  refuseUnknown(file, file.extends === undefined ? PACK_KEYS : OVERRIDE_KEYS);
  return { policy: file, workflow: {} };
}

function policyOf(file: Record<string, unknown>, repo: string): { policy: Record<string, unknown>; workflow: PolicyWorkflow } {
  const header = { kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION } as const;
  const { policy: body, workflow } = readFile(file);
  if (body.extends !== undefined) return { policy: { ...header, ...readPolicyOverride({ ...body, ...header, repo }, repo) }, workflow };
  const { dropped, ...pack } = readCheckPack({ ...body, ...header, repo }, repo);
  if (dropped) throw new Error(`The policy file holds what no longer runs: ${listed(dropped)}.`);
  return { policy: pack, workflow: { ...workflow, decide: workflow.decide ?? decideOf(pack.actions, BLOCK_KINDS.some((kind) => workflow[kind]?.on === true)) } };
}

/**
 * The line of the deepest key or list item on `path` the document holds: a problem with a value is on its key's line,
 * and one with a missing key on its mapping's.
 */
function lineOf({ doc, lines }: Parsed, path: readonly PropertyKey[]): number | undefined {
  let node: unknown = doc.contents;
  let offset = isNode(node) ? node.range?.[0] : undefined;
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(key));
      if (!pair || !isScalar(pair.key)) break;
      offset = pair.key.range?.[0] ?? offset;
      node = pair.value;
    } else if (isSeq(node) && typeof key === "number" && isNode(node.items[key])) {
      node = node.items[key];
      offset = (node as Node).range?.[0] ?? offset;
    } else {
      break;
    }
  }
  return offset === undefined ? undefined : lines.linePos(offset).line;
}

function located(parsed: Parsed, { message, path }: PolicyFileError["problems"][number]): PolicyFileProblem {
  const line = lineOf(parsed, path);
  return line === undefined ? { message } : { message, line };
}

/** The policy the file holds, read and normalised as the hub stores it, or each reason it is refused with where it is in the file. */
export function checkPolicyFile(text: string, repo: string): PolicyFileCheck {
  let parsed: ReturnType<typeof parseYaml>;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    if (error instanceof PlacedProblem) return { ok: false, problems: [{ message: error.message, line: error.line, column: error.column }] };
    if (error instanceof Error) return { ok: false, problems: [{ message: error.message }] };
    throw error;
  }
  const file = asRecord(parsed.root);
  if (!file) return { ok: false, problems: [{ message: "The policy file must be a mapping." }] };
  try {
    return { ok: true, ...policyOf(file, repo) };
  } catch (error) {
    if (error instanceof PolicyFileError) return { ok: false, problems: error.problems.map((problem) => located(parsed, problem)) };
    if (error instanceof Error) return { ok: false, problems: [{ message: error.message }] };
    throw error;
  }
}

/** Why a directory or submodule at a policy file path is refused. */
export function notAFileReason(path: string): string {
  return `${path} is not a file.`;
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
