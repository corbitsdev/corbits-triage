// A repository's policy kept in the repository itself. The file holds what the stored policy holds, less what the
// repository already says: `kind`, `schemaVersion` and `repo`. Only YAML is read; another format is another path.
import { dump, JSON_SCHEMA, load } from "js-yaml";
import { asRecord } from "@corbits/common";
import { CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, checkPackSchema, policyOverrideSchema, readCheckPack, readPolicyOverride } from "./check-pack.js";

export const POLICY_FILE_PATH = ".corbits-triage.yaml";
export const POLICY_FILE_MAX_BYTES = 64 * 1024;

const IMPLIED_KEYS = ["kind", "schemaVersion", "repo"] as const;
const PACK_KEYS = ["checks", "custom", "actions", "labels"];
const OVERRIDE_KEYS = ["extends", ...PACK_KEYS];
const NODES_MAX = 10_000;
const DEPTH_MAX = 32;
const TOO_LARGE = `${POLICY_FILE_PATH} is too large or uses aliases.`;

/** Published as JSON Schema. `readPolicyFile` stays the authority. */
export const policyFileSchema = checkPackSchema.omit(...IMPLIED_KEYS).or(policyOverrideSchema.omit(...IMPLIED_KEYS));

function parseYaml(text: string): unknown {
  if (new TextEncoder().encode(text).length > POLICY_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
  try {
    return load(text, { schema: JSON_SCHEMA });
  } catch (error) {
    throw new Error(`${POLICY_FILE_PATH} is not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function unknownKeys(file: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(file).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${POLICY_FILE_PATH} has unknown keys: ${unknown.join(", ")}.`);
}

/** The policy the file holds, read and normalised as the hub stores it; throws an Error whose message says why the file is rejected. */
export function readPolicyFile(text: string, repo: string): Record<string, unknown> {
  const parsed = parseYaml(text);
  refuseExpansion(parsed);
  const file = asRecord(parsed);
  if (!file) throw new Error(`${POLICY_FILE_PATH} must be a mapping.`);
  const header = { kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION } as const;
  if (file.extends !== undefined) {
    unknownKeys(file, OVERRIDE_KEYS);
    return { ...header, ...readPolicyOverride({ ...file, ...header, repo }, repo) };
  }
  unknownKeys(file, PACK_KEYS);
  const { dropped, ...pack } = readCheckPack({ ...file, ...header, repo }, repo);
  if (dropped) throw new Error(`${POLICY_FILE_PATH} holds what no longer runs: ${dropped.join("; ")}.`);
  return pack;
}

/** The file for a stored policy, headed by where its schema is published. */
export function policyFileText(stored: Record<string, unknown>, schemaUrl: string): string {
  const body = Object.fromEntries(Object.entries(stored).filter(([key]) => !(IMPLIED_KEYS as readonly string[]).includes(key) && key !== "dropped"));
  return `# Corbits Triage policy. Schema: ${schemaUrl} (policyFile)\n${dump(body, { schema: JSON_SCHEMA, lineWidth: -1 })}`;
}
