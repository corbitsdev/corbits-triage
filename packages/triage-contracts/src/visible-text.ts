import { Parser } from "htmlparser2";
import { ISSUE_LINKS } from "./check-pack.js";
import type { RepoSource } from "./repo-source.js";

// C0 and C1 controls draw nothing; tab and line feed are layout and stay.
const CONTROL = /[^\P{Cc}\n\t]/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const JOINER = /[\u{200C}\u{200D}]/u;
const PRESENTATION = /[\u{FE0E}\u{FE0F}]/u;
const IDEOGRAPH_SELECTOR = /[\u{E0100}-\u{E01EF}]/u;
const MONGOLIAN_SELECTOR = /[\u{180B}-\u{180D}\u{180F}]/u;
const EMOJI = /\p{Emoji}/u;
const IDEOGRAPH = /\p{Ideographic}/u;
const MONGOLIAN_LETTER = /(?=\p{L})\p{sc=Mongolian}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_TAIL = /\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]/u;
// Scripts whose letters change shape when a ZWJ or ZWNJ sits between them.
const JOINING_SCRIPT = /[\p{scx=Arab}\p{scx=Syrc}\p{scx=Nkoo}\p{scx=Mong}\p{scx=Deva}\p{scx=Beng}\p{scx=Guru}\p{scx=Gujr}\p{scx=Orya}\p{scx=Taml}\p{scx=Telu}\p{scx=Knda}\p{scx=Mlym}\p{scx=Sinh}]/u;
const BLACK_FLAG = "\u{1F3F4}";
// The escape that starts a terminal colour code, which pasted logs carry and which hides no message.
const ESCAPE = "\u{1B}";
// England, Scotland and Wales: the only subdivision flags emoji fonts draw.
const FLAG_TAGS = new Set(["gbeng", "gbsct", "gbwls"].map(tagged));

const HEADING = /^h([1-6])$/;
const BLOCKS = new Set(["p", "div", "blockquote", "details", "summary", "table", "dl", "dt", "dd"]);
// Elements a reader sees drawn without text, which end a run of removed characters.
const DRAWN = new Set(["img", "svg", "input", "hr"]);
// The rest of the issue's path segment after what the linked-issue rule matches, such as Linear's `CL-123`.
const SEGMENT = /[^/?#\s]*/y;
// GitHub's own emoji images, whose alt is the `:name:` a reader sees drawn.
const EMOJI_SRC = "https://github.githubassets.com/images/icons/emoji/";
const EMOJI_NAME = /^:[\w+-]+:$/;
// The raw source GitHub ships beside a diagram it draws, and text only screen readers announce.
const HIDDEN_CLASS = /(?:^|\s)(?:render-plaintext-hidden|sr-only)(?:\s|$)/;

function tagged(region: string): string {
  return [...region].map((letter) => String.fromCodePoint(0xe0000 + letter.codePointAt(0)!)).join("") + "\u{E007F}";
}

function joins(chars: string[], at: number): boolean {
  const before = chars[at - 1] ?? "";
  const after = chars[at + 1] ?? "";
  if (JOINING_SCRIPT.test(before) && JOINING_SCRIPT.test(after)) return true;
  if (chars[at] !== "\u{200D}" || !PICTOGRAPH.test(after)) return false;
  return PICTOGRAPH.test(before) || (EMOJI_TAIL.test(before) && PICTOGRAPH.test(chars[at - 2] ?? ""));
}

/** A selector stays only where it picks a form readers see; anywhere else it is a channel for hidden data. */
function selects(char: string, before: string): boolean {
  if (PRESENTATION.test(char)) return EMOJI.test(before);
  if (IDEOGRAPH_SELECTOR.test(char)) return IDEOGRAPH.test(before);
  if (MONGOLIAN_SELECTOR.test(char)) return MONGOLIAN_LETTER.test(before);
  return false;
}

function shown(chars: string[], at: number): boolean {
  const char = chars[at]!;
  // A carriage return is only a line break as half of CRLF.
  if (char === "\r") return chars[at + 1] === "\n";
  if (CONTROL.test(char)) return false;
  if (!IGNORABLE.test(char)) return true;
  if (JOINER.test(char)) return joins(chars, at);
  return selects(char, chars[at - 1] ?? "");
}

/** What cleaning took out of a text: each run of adjacent characters removed, and each link that showed nothing. */
export interface Removed {
  runs: string[];
  emptyLinks: number;
  /** Nothing has been drawn since the last run, so characters removed from the next text continue it. */
  open: boolean;
}

/** `value` without the characters a reader never sees: controls and default-ignorable characters. */
export function visibleText(value: string, removed?: Removed): string {
  const chars = [...value];
  let kept = "";
  let run = removed?.open ? removed.runs.pop()! : "";
  function close() {
    if (run) removed?.runs.push(run);
    run = "";
  }
  for (let at = 0; at < chars.length; at++) {
    if (chars[at] === BLACK_FLAG && FLAG_TAGS.has(chars.slice(at + 1, at + 7).join(""))) {
      kept += chars.slice(at, at + 7).join("");
      at += 6;
      close();
    } else if (shown(chars, at)) {
      kept += chars[at];
      if (!/\s/.test(chars[at]!)) close();
    } else if (!(chars[at] === ESCAPE && chars[at + 1] === "[")) {
      run += chars[at];
    }
  }
  if (removed) removed.open = run !== "";
  close();
  return kept;
}

function hidden(name: string, attributes: Record<string, string>): boolean {
  return name === "rp" || "hidden" in attributes || HIDDEN_CLASS.test(attributes.class ?? "");
}

/**
 * A link's target is read only where the linked-issue rule would count it, so the rule still finds the issue the link
 * names; it ends with the issue's own id, leaving out any slug or query a reader never sees.
 */
function issueTarget(href: string): string | undefined {
  for (const pattern of Object.values(ISSUE_LINKS)) {
    const found = pattern.exec(href);
    if (!found) continue;
    SEGMENT.lastIndex = found.index + found[0].length;
    SEGMENT.exec(href);
    return visibleText(href.slice(0, SEGMENT.lastIndex));
  }
  return undefined;
}

/**
 * GitHub's own rendering of a body as plain text: what a reader sees, in its blocks. Attributes never reach it, and a
 * link keeps its target only when it links an issue or pull request.
 */
export function renderedText(html: string, removed?: Removed): string {
  const parts: string[] = [];
  // Breaks and spaces wait until the next text, so nothing is trimmed off what is already written.
  let breaks = 0;
  let space = false;
  let marker = false;
  let skipped = 0;
  let pre = 0;
  let cells = 0;
  // An image or icon draws a link even with no text.
  const links: Array<{ href: string; start: number; drawn: boolean }> = [];
  const lists: Array<{ ordered: boolean; next: number }> = [];

  function emit(text: string) {
    if (parts.length && breaks) parts.push("\n".repeat(breaks));
    else if (parts.length && space && !marker) parts.push(" ");
    breaks = 0;
    space = false;
    marker = false;
    parts.push(text);
  }
  // A list item's own paragraph starts on its marker's line.
  function line() {
    if (!marker) breaks = Math.max(breaks, 1);
  }
  function block() {
    if (!marker) breaks = 2;
  }
  function startMarker(text: string) {
    emit(text);
    marker = true;
  }

  function onopentag(name: string, attributes: Record<string, string>) {
    if (skipped || hidden(name, attributes)) {
      skipped++;
      return;
    }
    if (removed && DRAWN.has(name)) removed.open = false;
    const heading = HEADING.exec(name);
    if (heading) {
      block();
      startMarker(`${"#".repeat(Number(heading[1]))} `);
    } else if (name === "ul" || name === "ol") {
      if (lists.length) line();
      else block();
      lists.push({ ordered: name === "ol", next: 1 });
    } else if (name === "li") {
      line();
      const list = lists.at(-1);
      startMarker("  ".repeat(Math.max(lists.length - 1, 0)) + (list?.ordered ? `${list.next++}. ` : "- "));
    } else if (name === "pre") {
      block();
      emit("```");
      breaks = 1;
      pre++;
    } else if (name === "code" && !pre) {
      emit("`");
    } else if (name === "br") {
      if (cells) space = true;
      else breaks = Math.min(breaks + 1, 2);
    } else if (name === "hr") {
      block();
      emit("---");
      block();
    } else if (name === "tr") {
      line();
    } else if (name === "td" || name === "th") {
      cells++;
      emit("|");
      space = true;
    } else if (name === "input" && attributes.type === "checkbox") {
      emit("checked" in attributes ? "[x]" : "[ ]");
    } else if (name === "img" || name === "svg") {
      const link = links.at(-1);
      if (link) link.drawn = true;
      const alt = attributes.alt ?? "";
      if (attributes.src?.startsWith(EMOJI_SRC) && EMOJI_NAME.test(alt)) emit(alt);
    } else if (name === "a") {
      links.push({ href: attributes.href ?? "", start: parts.length, drawn: false });
    } else if (BLOCKS.has(name)) {
      block();
    }
  }

  function onclosetag(name: string) {
    if (skipped) {
      skipped--;
      return;
    }
    if (name === "pre") {
      pre--;
      breaks = 1;
      emit("```");
      block();
    } else if (name === "code" && !pre) {
      space = false;
      emit("`");
    } else if (name === "a") {
      const link = links.pop()!;
      const text = parts.slice(link.start).join("").trim();
      const target = text ? issueTarget(link.href) : undefined;
      if (target) parts.push(` (${target})`);
      if (!text && !link.drawn && link.href && removed) removed.emptyLinks++;
    } else if (name === "ul" || name === "ol") {
      lists.pop();
      if (lists.length) line();
      else block();
    } else if (name === "td" || name === "th") {
      cells--;
      space = true;
    } else if (name === "tr") {
      emit("|");
    } else if (HEADING.test(name) || BLOCKS.has(name)) {
      block();
    }
  }

  function ontext(text: string) {
    if (skipped) return;
    const clean = visibleText(text, removed);
    if (pre) {
      let end = clean.length;
      while (end > 0 && clean[end - 1] === "\n") end--;
      if (end > 0) emit(clean.slice(0, end));
      breaks += clean.length - end;
      return;
    }
    const words = clean.replace(/\s+/g, " ");
    if (words.startsWith(" ")) space = true;
    const trimmed = words.trim();
    if (trimmed) emit(trimmed);
    if (words.endsWith(" ")) space = true;
  }

  new Parser({ onopentag, onclosetag, ontext }, { decodeEntities: true }).end(html);
  return parts.join("");
}

/**
 * A pull request body as a reader sees it: GitHub's own rendering holds only what a reader sees, Bitbucket Data Center
 * shows the body as written. Undefined when GitHub sent a body without its rendering.
 */
export function shownBody(pr: { body?: string | null; bodyHtml?: string | null }, source: RepoSource, removed?: Removed): string | undefined {
  if (source !== "github") return visibleText(pr.body ?? "", removed);
  if (typeof pr.bodyHtml === "string") return renderedText(pr.bodyHtml, removed);
  return pr.body ? undefined : "";
}
