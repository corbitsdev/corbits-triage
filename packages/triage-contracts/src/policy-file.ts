// A repository's policy kept in the repository itself. The file holds what the stored policy holds, less what the
// repository already says: `kind`, `schemaVersion` and `repo`. Only YAML is read; another format is another path.
import { dump, JSON_SCHEMA, load } from "js-yaml";
import { asRecord } from "@corbits/common";
import { CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, checkPackSchema, extendsOf, policyOverrideSchema, readCheckPack, readPolicyOverride } from "./check-pack.js";

export const POLICY_FILE_PATH = ".corbits-triage.yaml";

const IMPLIED_KEYS = ["kind", "schemaVersion", "repo"] as const;

/** Published as JSON Schema. `readPolicyFile` stays the authority. */
export const policyFileSchema = checkPackSchema.omit(...IMPLIED_KEYS).or(policyOverrideSchema.omit(...IMPLIED_KEYS));

function parseYaml(text: string): unknown {
  try {
    return load(text, { schema: JSON_SCHEMA });
  } catch (error) {
    throw new Error(`${POLICY_FILE_PATH} is not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The policy the file holds, as the hub stores it; throws an Error whose message says why the file is rejected. */
export function readPolicyFile(text: string, repo: string): Record<string, unknown> {
  const file = asRecord(parseYaml(text));
  if (!file) throw new Error(`${POLICY_FILE_PATH} must be a mapping.`);
  const stored = { ...file, kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION, repo };
  if (extendsOf(stored) === undefined) readCheckPack(stored, repo);
  else readPolicyOverride(stored, repo);
  return stored;
}

/** The file for a stored policy, headed by where its schema is published. */
export function policyFileText(stored: Record<string, unknown>, schemaUrl: string): string {
  const body = Object.fromEntries(Object.entries(stored).filter(([key]) => !(IMPLIED_KEYS as readonly string[]).includes(key) && key !== "dropped"));
  return `# Corbits Triage policy. Schema: ${schemaUrl} (policyFile)\n${dump(body, { schema: JSON_SCHEMA, lineWidth: -1 })}`;
}
