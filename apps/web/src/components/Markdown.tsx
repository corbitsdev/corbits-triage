import { useMemo } from "react";
import DOMPurify from "dompurify";
import { markdownHtml } from "../lib/markdown.ts";

// Text a pull request author wrote is untrusted. The policy blocks remote images, so they are dropped rather than shown broken;
// headings would outrank the pane's own, and classes would pick up the portal's styles.
const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["h1", "h2", "h3", "h4", "h5", "h6", "img", "area", "map", "style", "form", "input", "button", "select", "textarea", "video", "audio", "source"],
  FORBID_ATTR: ["class", "style", "background"],
};

function openLinksOutside(node: Element) {
  if (!node.hasAttribute("href")) return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
}

// Without a DOM, as when tests render the inbox on the server, DOMPurify has no hooks to add.
if (DOMPurify.isSupported) DOMPurify.addHook("afterSanitizeAttributes", openLinksOutside);

function sanitized(text: string): string | null {
  const html = markdownHtml(text);
  if (html === null) return null;
  try {
    return DOMPurify.sanitize(html, PURIFY);
  } catch {
    return null;
  }
}

/** GitHub-flavored markdown, sanitized before it reaches the page; text too deep or too long to parse safely shows as written. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => sanitized(text), [text]);
  if (html === null) return <p className="md plain">{text}</p>;
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
