// A repository's policy kept in the repository itself: schema 3 (`rules`, see policy-rules.ts), or the stored policy's
// shape less what the repository already says (`kind`, `schemaVersion` and `repo`). Only YAML is read; another format is another path.
import { dump, JSON_SCHEMA, load, YAMLException } from "js-yaml";
import { asRecord } from "@corbits/common";
import { CATALOG_IDS, CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, readCheckPack, readPolicyOverride } from "./check-pack.js";
import { isPolicyRulesFile, policyRulesSchema, rulesToPolicy } from "./policy-rules.js";

export const POLICY_FILE_PATH = ".corbits-triage.yaml";
export const POLICY_FILE_MAX_BYTES = 64 * 1024;

const IMPLIED_KEYS = ["kind", "schemaVersion", "repo"] as const;
const PACK_KEYS = ["checks", "custom", "actions", "labels"];
const OVERRIDE_KEYS = ["extends", ...PACK_KEYS];
const NODES_MAX = 10_000;
const DEPTH_MAX = 32;
const TOO_LARGE = `${POLICY_FILE_PATH} is too large or uses aliases.`;

/** Published as JSON Schema: schema 3, the shape new files are written in. `readPolicyFile` stays the authority and still reads the older shape. */
export const policyFileSchema = policyRulesSchema;

function parseYaml(text: string): unknown {
  if (new TextEncoder().encode(text).length > POLICY_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
  try {
    return load(text, { schema: JSON_SCHEMA });
  } catch (error) {
    if (!(error instanceof YAMLException)) throw error;
    // The full message quotes the file; the reason and position say enough without carrying its content into logs.
    throw new Error(`${POLICY_FILE_PATH} is not YAML: ${error.reason} at line ${error.mark.line + 1}, column ${error.mark.column + 1}.`);
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
  if (unknown.length > 0) throw new Error(`${POLICY_FILE_PATH} has unknown keys: ${listed(unknown)}.`);
  // The stored policy drops a rule id it does not know, which in a file is a typo that leaves the real rule at its default.
  const checks = Object.keys(asRecord(file.checks) ?? {}).filter((id) => !(CATALOG_IDS as readonly string[]).includes(id));
  if (checks.length > 0) throw new Error(`${POLICY_FILE_PATH} has unknown checks: ${listed(checks)}.`);
}

/** The policy the file holds, read and normalised as the hub stores it; throws an Error whose message says why the file is rejected. */
export function readPolicyFile(text: string, repo: string): Record<string, unknown> {
  const parsed = parseYaml(text);
  refuseExpansion(parsed);
  const file = asRecord(parsed);
  if (!file) throw new Error(`${POLICY_FILE_PATH} must be a mapping.`);
  const header = { kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION } as const;
  const rules = isPolicyRulesFile(file);
  if (!rules) refuseUnknown(file, file.extends === undefined ? PACK_KEYS : OVERRIDE_KEYS);
  const body = rules ? rulesToPolicy(file) : file;
  if (body.extends !== undefined) return { ...header, ...readPolicyOverride({ ...body, ...header, repo }, repo) };
  const { dropped, ...pack } = readCheckPack({ ...body, ...header, repo }, repo);
  if (dropped) throw new Error(`${POLICY_FILE_PATH} holds what no longer runs: ${listed(dropped)}.`);
  return pack;
}

/** The file for a stored policy. Repositories can be public, so it names nothing about the hub that wrote it. */
export function policyFileText(stored: Record<string, unknown>): string {
  const body = Object.fromEntries(Object.entries(stored).filter(([key]) => !(IMPLIED_KEYS as readonly string[]).includes(key) && key !== "dropped"));
  return `# Corbits Triage policy.\n${dump(body, { schema: JSON_SCHEMA, lineWidth: -1 })}`;
}
