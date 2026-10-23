/** A line range of the head side of a file. */
export interface Site {
  path: string;
  start: number;
  end: number;
}

export interface Finding extends Site {
  /** The verbatim line the finding names as the cause, when the reply gives one. */
  code?: string;
  title?: string;
  why?: string;
  trigger?: string;
  /** 0 blocks release, 1 is urgent, 2 is normal, 3 is low. */
  priority?: number;
}

const TEXT_FIELDS = ["code", "title", "why", "trigger"] as const;

type Parsed = { findings: Finding[] } | { unparsable: string };

// A model sometimes ends a finding with a stray key and no value: `"trigger": "...", "}"}]}`.
function withoutStrayKeys(json: string): string {
  return json.replace(/,\s*"\}"\s*\}/g, "}");
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(withoutStrayKeys(json));
    } catch {
      return undefined;
    }
  }
}

function findingsListOf(json: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(json) || !Array.isArray(json.findings)) return undefined;
  return json.findings.every(isRecord) ? json.findings : undefined;
}

/** The `findings` array of the first balanced JSON object in `text` that parses and holds one, trying each `{` in turn. */
export function firstFindingsList(text: string): Record<string, unknown>[] | undefined {
  for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
    const close = closingBrace(text, open);
    if (close === -1) continue;
    const list = findingsListOf(parseJson(text.slice(open, close + 1)));
    if (list) return list;
  }
  return undefined;
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function firstOf(item: Record<string, unknown>, keys: readonly string[]): unknown {
  return keys.map((key) => item[key]).find((value) => value !== undefined);
}

const PATH_KEYS = ["path", "file", "filename", "file_path", "filePath"];
const START_KEYS = ["start", "start_line", "startLine", "line_start", "lineStart", "line", "line_number", "lineNumber"];
const END_KEYS = ["end", "end_line", "endLine", "line_end", "lineEnd"];

/** A line, or a range written as "120-122", "L120-L122" or [120, 122]. */
function rangeOf(value: unknown): [number, number] | undefined {
  const line = integerOf(value);
  if (line !== undefined) return [line, line];
  if (Array.isArray(value) && value.length > 0) {
    const [start, end] = [integerOf(value[0]), integerOf(value[value.length - 1])];
    return start === undefined || end === undefined ? undefined : [start, end];
  }
  const match = typeof value === "string" ? /^L?(\d+)(?:\s*[-:]\s*L?(\d+))?$/.exec(value.trim()) : null;
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : undefined;
}

/** Any finding shape with a path and a line or a line range, flat or under `location`. */
export function findingOf(raw: unknown): Finding | undefined {
  if (!isRecord(raw)) return undefined;
  const item = isRecord(raw.location) ? { ...raw, ...raw.location } : raw;
  const path = firstOf(item, PATH_KEYS);
  if (typeof path !== "string") return undefined;
  const range = rangeOf(firstOf(item, ["lines", "line_range", "lineRange", "range"])) ?? rangeOf(firstOf(item, START_KEYS));
  if (!range) return undefined;
  const [start, rangeEnd] = range;
  const end = integerOf(firstOf(item, END_KEYS)) ?? rangeEnd;
  const finding: Finding = { path: path.replace(/^(\.\/|[ab]\/)/, ""), start: Math.min(start, end), end: Math.max(start, end) };
  for (const field of TEXT_FIELDS) if (typeof item[field] === "string") finding[field] = item[field];
  const priority = integerOf(item.priority);
  if (priority !== undefined) finding.priority = priority;
  return finding;
}

/** The reply's findings, from the first JSON object in it that holds a `findings` list. */
export function parseFindings(reply: string): Parsed {
  const list = firstFindingsList(reply);
  if (!list) return { unparsable: "no findings list" };
  return { findings: list.map(findingOf).filter((finding) => finding !== undefined) };
}

/** The first non-blank line of the finding's quoted code. */
export function quotedLine(finding: Finding): string | undefined {
  return finding.code?.split("\n").find((row) => row.trim() !== "")?.trim();
}

/** Every file the diff adds, changes or deletes, by its head-side path, or its base-side path when deleted. */
export function changedFiles(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)].map((match) => match[1]!))];
}

/** Whether two paths name the same file, one possibly given relative to a subdirectory of the other's root. */
export function samePath(a: string, b: string): boolean {
  return a !== "" && b !== "" && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
}

/** A finding a linter or a CI tool reported, as a fix workflow takes it. */
export interface ToolFinding {
  /** The linter, check run or Code Insights report that reported it. */
  source: string;
  rule?: string;
  path: string;
  /** Absent when it is about the whole file. */
  line?: number;
  message: string;
  severity: "error" | "warning" | "notice";
  fix?: string;
}

/** A tool's findings, or why it has none to give: `skipped` read nothing, `incomplete` failed and found nothing it can vouch for. */
export type ToolFindings = { status: "complete"; findings: ToolFinding[] } | { status: "skipped"; reason: string } | { status: "incomplete"; reason: string };
