import { Marked, type Tokens } from "marked";

// GitHub's own limit on a pull request or issue body.
const MAX_LENGTH = 65536;
// marked recurses once per quote or list level; thousands of them overflow the browser's stack.
const MAX_DEPTH = 32;
const PREFIX = /^[\s>]*/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;

function depth(line: string): number {
  const quotes = (PREFIX.exec(line)?.[0].match(/>/g) ?? []).length;
  const indent = LIST_ITEM.exec(line)?.[1]?.length ?? 0;
  return quotes + Math.floor(indent / 2);
}

function demotedHeading(this: { parser: { parseInline: (tokens: Tokens.Heading["tokens"]) => string } }, { tokens }: Tokens.Heading): string {
  return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>`;
}

const marked = new Marked({ gfm: true, breaks: true, renderer: { heading: demotedHeading } });

/** Markdown as HTML, not yet sanitized; null when the text is too long or nested too deep to parse safely. */
export function markdownHtml(text: string): string | null {
  if (text.length > MAX_LENGTH || text.split("\n").some((line) => depth(line) > MAX_DEPTH)) return null;
  try {
    return marked.parse(text, { async: false });
  } catch {
    return null;
  }
}
