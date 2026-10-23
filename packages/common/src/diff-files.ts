import { parsePatch } from "./patch.js";

type Prefixes = { old: string; new: string };

const GIT: Prefixes = { old: "a/", new: "b/" };
const BITBUCKET: Prefixes = { old: "src://", new: "dst://" };
const NONE: Prefixes = { old: "", new: "" };

const HEADER = "diff --git ";
const QUOTED = /"(?:[^"\\]|\\.)*"/.source;
const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A path git quoted C-style, whose octal escapes are the bytes of its UTF-8. */
function unquoted(quoted: string): string {
  const bytes: number[] = [];
  for (const [, escape, plain] of quoted.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
    if (plain !== undefined) bytes.push(...encoder.encode(plain));
    else if (/^[0-7]/.test(escape!)) bytes.push(Number.parseInt(escape!, 8));
    else bytes.push(...encoder.encode(ESCAPES[escape!] ?? escape!));
  }
  return decoder.decode(new Uint8Array(bytes));
}

function pathOf(written: string, prefix: string): string | undefined {
  const path = written.startsWith('"') ? unquoted(written) : written;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function prefixesOf(header: string): Prefixes {
  const first = header.replace(/^"/, "");
  if (first.startsWith(GIT.old)) return GIT;
  if (first.startsWith(BITBUCKET.old)) return BITBUCKET;
  return NONE;
}

/** The new path of a header that quotes either path; an unquoted path never holds a quote. */
function quotedNew(header: string): string | undefined {
  if (header.startsWith('"')) return header.match(new RegExp(`^${QUOTED} (.+)$`))?.[1];
  if (header.endsWith('"')) return header.match(new RegExp(` (${QUOTED})$`))?.[1];
  return undefined;
}

/** The new path from the header alone: quoted, or the same path on both sides, since an unquoted path may hold spaces. */
function headerPath(header: string, prefixes: Prefixes): string | undefined {
  const quoted = quotedNew(header);
  if (quoted !== undefined) return pathOf(quoted, prefixes.new);
  const half = (header.length - prefixes.old.length - prefixes.new.length - 1) / 2;
  const path = header.slice(prefixes.old.length, prefixes.old.length + half);
  return Number.isInteger(half) && half > 0 && header === `${prefixes.old}${path} ${prefixes.new}${path}` ? path : undefined;
}

/** A file line's path, without the tab git adds after a path with a space or the timestamp diff adds. */
function lineValue(lines: readonly string[], lead: string): string | undefined {
  const line = lines.find((l) => l.startsWith(lead));
  return line?.slice(lead.length).split("\t")[0];
}

function sectionPath(section: string): string | undefined {
  const lines = section.split("\n");
  const header = lines[0]!.slice(HEADER.length);
  const prefixes = prefixesOf(header);
  const end = lines.findIndex((line) => line.startsWith("@@"));
  const meta = end < 0 ? lines : lines.slice(0, end);
  const added = lineValue(meta, "+++ ");
  if (added !== undefined && added !== "/dev/null") return pathOf(added, prefixes.new);
  const renamed = lineValue(meta, "rename to ") ?? lineValue(meta, "copy to ");
  if (renamed !== undefined) return pathOf(renamed, "");
  const removed = lineValue(meta, "--- ");
  if (removed !== undefined && removed !== "/dev/null") return pathOf(removed, prefixes.old);
  return headerPath(header, prefixes);
}

/** The path of each file whose part of the diff ends after `from`; undefined when there is none or any path cannot be read. */
export function filesFrom(diff: string, from: number): string[] | undefined {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  const paths = starts.flatMap((start, i) => ((starts[i + 1] ?? diff.length) > from ? [sectionPath(diff.slice(start, starts[i + 1]))] : []));
  const known = paths.filter((path) => path !== undefined);
  return paths.length > 0 && known.length === paths.length ? known : undefined;
}

function sections(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, i) => diff.slice(start, starts[i + 1]));
}

/** The head-side lines the diff adds, by each file's head-side path; throws when a file's path cannot be read. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  for (const section of sections(diff)) {
    const path = sectionPath(section);
    if (path === undefined) throw new Error(`unreadable diff header: ${section.split("\n")[0]}`);
    const hunks = section.search(/^@@/m);
    if (hunks < 0) continue;
    const lines = parsePatch(section.slice(hunks)).flatMap((hunk) => hunk.lines.flatMap((line) => (line.kind === "add" ? [line.newNo!] : [])));
    if (lines.length > 0) added.set(path, new Set(lines));
  }
  return added;
}
