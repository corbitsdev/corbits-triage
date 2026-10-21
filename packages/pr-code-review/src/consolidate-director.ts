import { defineDirector } from "@intx/agent";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent, ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { checkoutOf, READ_FILE_TOOL, type Checkout } from "./actions/checkout.js";
import { MODEL_FAILED } from "./failures.js";
import { quotedLine, type Finding, type Site } from "./findings.js";
import { packageName } from "./package-name.js";
import { promptAttribute, promptText } from "./prompt-text.js";
import type { CodeReviewProfile } from "./profile.js";

// Lines read on each side of a finding's range, to find the line its quoted code names.
const READ_AROUND = 20;
// Most lines read for one finding; a longer range is read from its start.
const MAX_READ = 100;
// Lines shown to the model on each side of a finding's anchored range.
const SHOWN_AROUND = 3;

export interface ConsolidateDirectorConfig {
  name: string;
  schema: Record<string, unknown>;
}

interface Read {
  path: string;
  start: number;
  lines: number;
}

interface Window {
  text: string;
}

/** The findings the input lists between its <findings> tags. */
function findingsIn(content: string): Finding[] {
  const open = content.lastIndexOf("<findings>\n");
  const close = content.lastIndexOf("\n</findings>");
  if (open === -1 || close === -1) return [];
  return JSON.parse(content.slice(open + "<findings>\n".length, close)) as Finding[];
}

function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

// The read tools clip a line past 500 characters and end it with "…".
function showsLine(text: string, code: string): boolean {
  const shown = text.trim();
  return shown === code || (shown.endsWith("…") && code.startsWith(shown.slice(0, -1)));
}

/** The finding's range moved onto the read line its quoted code names, nearest its own line; its own range when none does. */
function anchored(finding: Finding, lines: ReadonlyMap<number, string>): Site {
  const site = { path: finding.path, start: finding.start, end: finding.end };
  const code = quotedLine(finding);
  if (!code) return site;
  const matches = [...lines].flatMap(([line, text]) => (showsLine(text, code) ? [line] : []));
  if (matches.length === 0) return site;
  const nearest = matches.reduce((best, line) => (Math.abs(line - finding.start) < Math.abs(best - finding.start) ? line : best));
  return { ...site, start: nearest, end: nearest + finding.end - finding.start };
}

function numbered(lines: ReadonlyMap<number, string>, from: number, to: number): string {
  const shown = [...lines].filter(([line]) => line >= from && line <= to).sort(([a], [b]) => a - b);
  return shown.map(([line, row]) => `${line}\t${row}`).join("\n");
}

function shown(site: Site, lines: ReadonlyMap<number, string>): string {
  return numbered(lines, site.start - SHOWN_AROUND, site.end + SHOWN_AROUND);
}

function cited(index: number, site: Site, lines: ReadonlyMap<number, string>): string {
  return `<finding index="${index}" path="${promptAttribute(site.path)}">\n${promptText(shown(site, lines))}\n</finding>`;
}

interface Range {
  path: string;
  start: number;
  end: number;
}

function around({ path, start, end }: Finding): Range {
  const from = Math.max(1, start - READ_AROUND);
  return { path, start: from, end: Math.min(from + MAX_READ - 1, end + READ_AROUND) };
}

/** The reads to make: every finding's surroundings, with overlapping or adjacent ones in a file joined into one. */
function readsOf(findings: readonly Finding[]): Read[] {
  const ranges = findings.map(around).sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
  const joined: Range[] = [];
  for (const range of ranges) {
    const last = joined.at(-1);
    if (last?.path === range.path && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    joined.push(range);
  }
  return joined.map(({ path, start, end }) => ({ path, start, lines: end - start + 1 }));
}

/**
 * Reads the lines around each finding the input lists at the head it names, through the host's `*_read_file`, out of
 * the model's history, each stretch of a file once, and moves each finding onto the line its quoted code names. Then
 * one model call, with the cited lines appended to the system prompt, decoded against the schema. The reply is the
 * model's JSON with `sites`, each finding's anchored range by index, `excerpts`, the numbered lines read around
 * each, and `unreadFindings`, the index of each finding the model was shown no line of, which keeps its range. A failed
 * model call or an answer that isn't JSON fails the step, so its retry asks again.
 */
function consolidateDirector(caps: ReactorCapabilities, basePrompt: string, { name, schema }: ConsolidateDirectorConfig): ReactorDirector {
  const reads = new Map<string, Read>();
  let checkout: Checkout;
  let findings: Finding[] = [];
  const files = new Map<string, Map<number, string>>();
  let sites: Site[] = [];
  let pending = 0;
  let next: ToolCall[] = [];

  function read({ path, start, lines }: Read): ToolCall {
    const id = `read-${reads.size + 1}`;
    reads.set(id, { path, start, lines });
    const { source, repo, sha } = checkout;
    return { id, name: READ_FILE_TOOL[source], arguments: { repo, sha, path, start, end: start + lines - 1 } };
  }

  function linesOf(path: string): Map<number, string> {
    const known = files.get(path);
    if (known) return known;
    const lines = new Map<number, string>();
    files.set(path, lines);
    return lines;
  }

  function infer() {
    sites = findings.map((finding) => anchored(finding, linesOf(finding.path)));
    const citedCode = sites.map((site, i) => cited(i, site, linesOf(site.path))).join("\n");
    const systemPrompt = `${basePrompt.trimEnd()}\n\n<cited_code>\n${citedCode}\n</cited_code>`;
    return caps.infer({ systemPrompt, tools: [], responseFormat: { kind: "json-schema", name, schema } });
  }

  function run(calls: ToolCall[]) {
    if (calls.length === 0) return infer();
    pending = calls.length;
    next = [];
    return caps.executeTools(calls, true, false);
  }

  function start(content: string) {
    const named = checkoutOf(content);
    if (!named) throw new Error(`${name}: the input names no repository head`);
    checkout = named;
    findings = findingsIn(content);
    if (findings.length === 0) return caps.reply(JSON.stringify({ groups: [], sites: [], excerpts: [], unreadFindings: [] }));
    return run(readsOf(findings).map(read));
  }

  function onRead(asked: Read, result: ToolResult) {
    if (result.isError) return;
    // A result over the reactor's size cap comes back as truncated text, so the window is read again in halves.
    if (typeof result.content === "string") {
      const half = Math.ceil(asked.lines / 2);
      if (asked.lines > 1) next.push(read({ ...asked, lines: half }), read({ path: asked.path, start: asked.start + half, lines: asked.lines - half }));
      return;
    }
    const { text } = result.content as unknown as Window;
    for (const row of text.split("\n")) {
      const tab = row.indexOf("\t");
      const line = Number(row.slice(0, tab));
      if (tab > 0 && Number.isInteger(line)) linesOf(asked.path).set(line, row.slice(tab + 1));
    }
  }

  function onToolDone(result: ToolResult) {
    const asked = reads.get(result.callId);
    if (asked) onRead(asked, result);
    if (--pending > 0) return [];
    return run(next);
  }

  function onTurn(turn: AssistantTurn) {
    const text = turnText(turn);
    try {
      const excerpts = sites.map((site) => numbered(linesOf(site.path), site.start - READ_AROUND, site.end + READ_AROUND));
      const unreadFindings = sites.flatMap((site, i) => (shown(site, linesOf(site.path)) === "" ? [i] : []));
      return caps.reply(JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), sites, excerpts, unreadFindings }));
    } catch {
      throw new Error(`${name}: replied without JSON: ${text.slice(0, 200)}`);
    }
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return start(event.message.content ?? "");
        case "tool.done":
          return onToolDone(event.result);
        case "inference.done":
          return onTurn(event.turn);
        case "inference.error":
          throw new Error(`${name}: ${MODEL_FAILED}: ${event.error.message}`);
        default:
          return [];
      }
    },
  };
}

export function consolidateDirectorOf(profile: CodeReviewProfile) {
  return defineDirector<ConsolidateDirectorConfig>({
    id: `${packageName(profile.packageName)}/consolidate`,
    configSchema: type({ name: "string", schema: "Record<string, unknown>" }),
    factory: function buildConsolidateDirector(config, _env, agent) {
      let inner: ReactorDirector | undefined;
      return {
        async decide(event, state, caps) {
          return (inner ??= consolidateDirector(caps, agent.systemPrompt, config)).decide(event, state, caps);
        },
      };
    },
  });
}
