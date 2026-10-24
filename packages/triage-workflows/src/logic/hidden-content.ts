import { visibleText, type Removed } from "@corbits/triage-contracts";

// Only hidden content that can carry a message counts. One stray invisible character, such as the zero-width space
// Dependabot puts after `@`, or one emoji presentation selector, cannot.
const TAG = /[\u{E0000}-\u{E007F}]/u;
const SELECTOR = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180D}\u{180F}]/u;
const PRESENTATION = /^[\u{FE0E}\u{FE0F}]$/u;
// Overrides and isolates reorder what is shown (Trojan Source); embeddings and the direction marks are ordinary in RTL text.
const BIDI = /[\u{202D}\u{202E}\u{2066}-\u{2069}]/u;
const DIRECTION = /[\u{200E}\u{200F}\u{061C}\u{202A}-\u{202C}]/gu;
const INVISIBLE = "invisible characters";

// What markdown hides: a comment, processing instruction, CDATA section or declaration, each of which runs to the end
// of the body when it never closes, and a reference definition.
const HIDDEN_MARKUP = [
  /<!--[\s\S]*?(?:-->|$)/g,
  /<\?[\s\S]*?(?:\?>|$)/g,
  /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g,
  /<![A-Za-z][^>]*(?:>|$)/g,
  /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*\n?[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]*\n?[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?/gm,
];

// Unless said in the negative on the same line, as a maintainer's warning is; "why not" asks for it.
const AFFIRMED = String.raw`(?<!(?:(?<!\bwhy[ \t]+)\bnot|n't|\bnever)[ \t]+)`;

// Only a line's first "close" is tried, so a line of them is read once.
const CLOSE_OTHERS = /^(?:(?!\bclose\b).)*\bclose\b.*\bother\s+(?:prs?|pull\s+requests)\b/im;

/**
 * Text addressed to a model, seeded from the injection attempts Triage has seen and kept to what a maintainer's own
 * wording does not say; read only where a reader can't see it.
 */
const INSTRUCTIONS = [
  new RegExp(`${AFFIRMED}\\b(?:ignore|disregard|forget|override)\\s+(?:(?:all|any|of|the)\\s+)*(?:previous|prior|above|earlier|preceding|your|system)\\s+(?:instructions?|prompts?|rules|guidelines|polic(?:y|ies)|directives)\\b`, "i"),
  new RegExp(`${AFFIRMED}\\b(?:ignore|disregard|forget)\\s+all\\s+(?:instructions?|prompts?|rules)\\b`, "i"),
  /\bsystem\s+prompt\s*:|\[(?:system|inst)\]|<\|(?:im_start|im_end|system|endoftext)\|>|<\/?system>/i,
  /\b(?:you\s+are\s+(?:now\s+)?|act\s+as\s+)(?:an?\s+)?(?:ai|llm|language\s+model|assistant|chatbot)\b/i,
  /\b(?:ai|llm|language\s+model|assistant|chatbot)s?\s*[,:]\s*(?:please\s+)?(?:approve|merge|ignore|pass|close)\b/i,
  /\bbypass\s+(?:the\s+)?(?:human|maintainer|manual|review|triage|approval|policy)/i,
  new RegExp(`${AFFIRMED}\\b(?:approve|merge|close)\\s+(?:it\\s+|this\\s+(?:pr\\s+|pull\\s+request\\s+)?)?without\\s+(?:a\\s+|any\\s+)?(?:maintainer|human|manual|reviewer)`, "i"),
  /\ballowlist\s+(?:me|this)\b|\bstanding\s+approval\b/i,
  new RegExp(`${AFFIRMED}\\b(?:approve|merge|pass)\\s+(?:this|the)\\s+(?:pr|pull\\s+request|change)s?\\s+(?:immediately|now|automatically|without)\\b`, "i"),
  /\b(?:mark|treat|label)\s+(?:this|it|me)\s+as\s+(?:approved|safe|trusted)\b/i,
  /\bclose\s+all\s+(?:other\s+)?(?:prs?|pull\s+requests|issues)\b/i,
  CLOSE_OTHERS,
];

export function nothingRemoved(): Removed {
  return { runs: [], emptyLinks: 0, open: false };
}

function runKind(run: string): string | undefined {
  if (TAG.test(run)) return "Unicode tag characters";
  if (BIDI.test(run)) return "bidi controls";
  if (PRESENTATION.test(run)) return undefined;
  if (SELECTOR.test(run)) return "variation selectors";
  return [...run.replace(DIRECTION, "")].length > 1 ? INVISIBLE : undefined;
}

function kindsOf(removed: Removed): Set<string> {
  const kinds = new Set(removed.runs.map(runKind).filter((kind) => kind !== undefined));
  if (removed.emptyLinks) kinds.add("link with no text");
  return kinds;
}

/** What cleaning one place's text found hidden there, as `where: what`, each kind once. */
export function hiddenIn(where: string, removed: Removed): string[] {
  return [...kindsOf(removed)].map((kind) => `${where}: ${kind}`);
}

function words(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function markupOf(markdown: string): string[] {
  return HIDDEN_MARKUP.flatMap((pattern) => [...markdown.matchAll(pattern)].map((match) => match[0]));
}

/** The description as written, without the pieces a pull request template put there and the characters a reader never sees. */
export function writtenDescription(markdown: string, templates: readonly string[]): string {
  const given = new Set(templates.flatMap(markupOf).map(words));
  const own = markupOf(markdown).filter((piece) => given.has(words(piece)));
  return visibleText(own.reduce((text, piece) => text.replace(piece, ""), markdown));
}

/**
 * What the markup a GitHub body's markdown hides, and its rendering does not show, holds beyond what a pull request
 * template put there: smuggled characters, or text that speaks to a model.
 */
export function hiddenMarkup(markdown: string, rendered: string, templates: readonly string[]): string[] {
  const shown = words(rendered);
  // Only a whole piece of a template's own markup is the template's; a piece cut short or added to is the author's.
  const given = new Set(templates.flatMap(markupOf).map(words));
  const added = markupOf(markdown).filter((piece) => !shown.includes(words(visibleText(piece))) && !given.has(words(piece)));
  const kinds = new Set<string>();
  for (const piece of added) {
    const removed = nothingRemoved();
    const text = visibleText(piece, removed);
    for (const kind of kindsOf(removed)) if (kind !== INVISIBLE) kinds.add(kind);
    if (INSTRUCTIONS.some((pattern) => pattern.test(text))) kinds.add("hidden comment aimed at a model");
  }
  return [...kinds];
}
