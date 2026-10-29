import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { errorText } from "@corbits/common";
import { defineTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { checkoutsUnder, sidecarDataDir } from "./checkouts";
import { MAX_LINES } from "./lines";
import { grep, list, MAX_ENTRIES, MAX_MATCHES, readLines } from "./repo-read";

const str = { type: "string" };
const path = { type: "string", description: "Path relative to the repository root" };

export const REPO_READ_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: `Read lines start to end (1-based, inclusive) of a file in the repository, at most ${MAX_LINES} lines and fewer when long lines fill the page, each prefixed with its line number; end in the result is the last line returned.`,
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

/** Where `read_file` and `list` read the folder a call names as `diffRoot`; no repository path is absolute, so none is shadowed. */
export const DIFF_MOUNT = "/diff";

/**
 * The call confined to the checkout at `root`, and paths under DIFF_MOUNT to `diffRoot` when given. The tools hold no
 * root of their own: the director that runs them names both on every call, over whatever the model passed; the model's
 * own call stays in history.
 */
export function rootedAt<T extends ToolCallInput>(call: T, root: string, diffRoot?: string): T {
  return { ...call, arguments: { ...call.arguments, root, ...(diffRoot !== undefined && { diffRoot }) } };
}

/** The path below DIFF_MOUNT that `path` names, if it names one. */
function mounted(path: unknown): string | undefined {
  if (path === DIFF_MOUNT) return ".";
  return typeof path === "string" && path.startsWith(`${DIFF_MOUNT}/`) ? path.slice(DIFF_MOUNT.length + 1) : undefined;
}

export function isBelow(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function realpathOf(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** The real path of a root inside `checkouts`; any other root, however it is spelled or linked, is refused. */
async function confineRoot(root: unknown, checkouts: string): Promise<string> {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("the call names no checkout to read");
  const [base, real] = await Promise.all([realpathOf(checkouts), realpathOf(root)]);
  if (!base || !real || !isBelow(base, real)) throw new Error(`${root} is not a checkout on this sidecar`);
  return real;
}

/** A read_file or list under DIFF_MOUNT, confined to the call's `diffRoot` and answered with the path the model gave. */
async function dispatchMounted(call: ToolCallInput, below: string, checkouts: string): Promise<unknown> {
  const a = call.arguments;
  const root = await confineRoot(a.diffRoot, checkouts);
  switch (call.name) {
    case "read_file":
      return { ...(await readLines(root, below, a.start, a.end)), path: a.path };
    case "list":
      return { ...(await list(root, below)), path: a.path };
    default:
      throw new Error(`${call.name} does not read ${DIFF_MOUNT}`);
  }
}

async function dispatch(call: ToolCallInput, checkouts: string): Promise<unknown> {
  const a = call.arguments;
  if (typeof a.refusal === "string") throw new Error(a.refusal);
  const below = mounted(a.path);
  if (below !== undefined) return dispatchMounted(call, below, checkouts);
  const root = await confineRoot(a.root, checkouts);
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

/**
 * Read-only, uncredentialed and unmarked, so it runs unattended; every path is confined to the checkout its call names,
 * which must be inside the checkouts folder of the sidecar data dir `dataDir` names.
 */
export function repoReadUnder(dataDir: () => string) {
  async function run(call: ToolCallInput) {
    try {
      return { callId: call.id, content: (await dispatch(call, checkoutsUnder(dataDir()))) as Record<string, unknown> };
    } catch (err) {
      return { callId: call.id, content: errorText(err), isError: true };
    }
  }
  return defineTool({
    id: "@corbits/repo-read-tool/sidecar-bundle",
    definitions: REPO_READ_DEFINITIONS.map((d) => ({ name: d.name })),
    factory: function repoReadToolFactory() {
      return { definitions: REPO_READ_DEFINITIONS, run };
    },
  });
}

export const repoRead = repoReadUnder(sidecarDataDir);
