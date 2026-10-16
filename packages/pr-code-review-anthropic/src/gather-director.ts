import { defineDirector } from "@intx/agent";
import type { ReactorCapabilities, ReactorDirector, ReactorInboundEvent, ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { checkoutOf, READ_FILE_TOOL, type Checkout } from "./actions/checkout.js";

// Tool results over the reactor's 10k-character size cap come back truncated, so reads stay small and a
// truncated one is read again in halves.
const WINDOW_LINES = 100;

interface Read {
  path: string;
  start: number;
  lines: number;
}

interface Window {
  end: number;
  totalLines: number;
  text: string;
}

function withoutNumbers(text: string): string[] {
  return text.split("\n").map((line) => line.slice(line.indexOf("\t") + 1));
}

/**
 * No model: reads every file the input's JSON `paths` names in full at the head the input names, through the host's
 * contents API, and replies {"files": {path: text}}; a file that is missing or binary is left out.
 */
function gatherDirector(caps: ReactorCapabilities): ReactorDirector {
  const reads = new Map<string, Read>();
  const windows = new Map<string, Map<number, string[]>>();
  // Paths whose windows past the first are already asked for.
  const planned = new Set<string>();
  let checkout: Checkout;
  let pending = 0;
  let next: ToolCall[] = [];

  function read(path: string, start: number, lines = WINDOW_LINES): ToolCall {
    const id = `read-${reads.size + 1}`;
    reads.set(id, { path, start, lines });
    const { source, repo, sha } = checkout;
    return { id, name: READ_FILE_TOOL[source], arguments: { repo, sha, path, start, end: start + lines - 1 } };
  }

  function files(): Record<string, string> {
    function joined(byStart: Map<number, string[]>): string {
      return [...byStart].sort(([a], [b]) => a - b).flatMap(([, lines]) => lines).join("\n");
    }
    return Object.fromEntries([...windows].map(([path, byStart]) => [path, joined(byStart)]));
  }

  function run(calls: ToolCall[]) {
    if (calls.length === 0) return caps.reply(JSON.stringify({ files: files() }));
    pending = calls.length;
    next = [];
    return caps.executeTools(calls, true, false);
  }

  function start(content: string) {
    const named = checkoutOf(content);
    if (!named) return caps.reply("gather: the input names no repository head");
    checkout = named;
    const { paths } = JSON.parse(content.slice(content.indexOf("\n") + 1)) as { paths: string[] };
    return run(paths.map((path) => read(path, 1)));
  }

  function onRead(asked: Read, result: ToolResult) {
    if (result.isError) return;
    if (typeof result.content === "string") {
      const half = Math.ceil(asked.lines / 2);
      if (asked.lines > 1) next.push(read(asked.path, asked.start, half), read(asked.path, asked.start + half, asked.lines - half));
      return;
    }
    const window = result.content as unknown as Window;
    const byStart = windows.get(asked.path) ?? new Map<number, string[]>();
    windows.set(asked.path, byStart.set(asked.start, withoutNumbers(window.text)));
    if (planned.has(asked.path)) return;
    planned.add(asked.path);
    for (let line = WINDOW_LINES + 1; line <= window.totalLines; line += WINDOW_LINES) next.push(read(asked.path, line));
  }

  function onToolDone(result: ToolResult) {
    const asked = reads.get(result.callId);
    if (asked) onRead(asked, result);
    if (--pending > 0) return [];
    return run(next);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return start(event.message.content ?? "");
        case "tool.done":
          return onToolDone(event.result);
        case "abort":
          return caps.reply("gather: aborted");
        default:
          return [];
      }
    },
  };
}

export const gather = defineDirector<Record<string, never>>({
  id: "@corbits/pr-code-review-anthropic/gather",
  configSchema: type({}),
  factory: function buildGatherDirector() {
    let inner: ReactorDirector | undefined;
    return {
      async decide(event, state, caps) {
        return (inner ??= gatherDirector(caps)).decide(event, state, caps);
      },
    };
  },
});
