import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { grep, list, MAX_ENTRIES, MAX_LINES, MAX_MATCHES, readLines } from "./repo-read";

const str = { type: "string" };
const path = { type: "string", description: "Path relative to the repository root" };

export const REPO_READ_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: `Read lines start to end (1-based, inclusive) of a file in the repository, at most ${MAX_LINES} lines, each prefixed with its line number.`,
    inputSchema: { type: "object", properties: { path, start: { type: "integer" }, end: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "grep",
    description: `Search the repository's text files for lines matching an RE2 regular expression, optionally only files matching a glob such as **/*.ts. Returns at most ${MAX_MATCHES} matches.`,
    inputSchema: { type: "object", properties: { pattern: str, glob: str }, required: ["pattern"] },
  },
  {
    name: "list",
    description: `List a directory of the repository, at most ${MAX_ENTRIES} entries. path defaults to the root.`,
    inputSchema: { type: "object", properties: { path }, required: [] },
  },
];

type ToolCallInput = { id: string; name: string; arguments: Record<string, any> };

/**
 * The call answered with `reason` as its error instead of run. A director has no way to answer a tool call itself, so
 * one that refuses a call (a spent read budget) dispatches this in its place; the model's own call stays in history.
 */
export function refused<T extends ToolCallInput>(call: T, reason: string): T {
  return { ...call, arguments: { refusal: reason } };
}

async function dispatch(root: string, call: ToolCallInput): Promise<unknown> {
  const a = call.arguments;
  if (typeof a.refusal === "string") throw new Error(a.refusal);
  switch (call.name) {
    case "read_file":
      return readLines(root, a.path, a.start, a.end);
    case "grep":
      return grep(root, a.pattern, a.glob);
    case "list":
      return list(root, a.path);
    default:
      throw new Error(`unknown tool ${call.name}`);
  }
}

function createRepoReadTools(root: string) {
  async function run(call: ToolCallInput) {
    try {
      return { callId: call.id, content: (await dispatch(root, call)) as Record<string, unknown> };
    } catch (err) {
      return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
  return { definitions: REPO_READ_DEFINITIONS, run };
}

interface Env extends BaseEnv {
  toolCwd: string;
}

/** Read-only, uncredentialed and unmarked, so it runs unattended; every path is confined to the step's working tree. */
export const repoRead = defineTool<Env>({
  id: "@corbits/repo-read-tool/sidecar-bundle",
  requires: ["toolCwd"],
  definitions: REPO_READ_DEFINITIONS.map((d) => ({ name: d.name })),
  factory: function repoReadToolFactory(env) {
    return createRepoReadTools(env.toolCwd);
  },
});
