// The new pull request page's composer first, then the classic form's.
const COMMENT_BOXES = [
  'textarea[aria-label="Markdown value"]',
  'textarea[placeholder="Use Markdown to format your comment"]',
  "textarea#new_comment_field",
  'textarea[name="comment[body]"]',
];

export function findCommentBox(): HTMLTextAreaElement | undefined {
  for (const selector of COMMENT_BOXES) {
    const boxes = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].filter((box) => !box.disabled && !box.closest('[hidden], .js-inline-comment-form, [data-testid="inline-comment"]'));
    if (boxes.length) return boxes.at(-1);
  }
  return undefined;
}

/**
 * Adds the draft to GitHub's comment box the way typing would, so GitHub's own editor keeps its state; nothing is
 * submitted. React-controlled boxes ignore a plain `value` write, so the native setter is used before the input event.
 */
export function setBox(box: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set;
  if (!setter) throw new Error("This browser cannot set the comment box.");
  setter.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

export function insertDraft(body: string): void {
  const box = findCommentBox();
  if (!box) throw new Error("No comment box here. Open the Conversation tab, signed in to GitHub, and try again.");
  const value = box.value.trim() ? `${box.value.trimEnd()}\n\n${body}` : body;
  box.focus();
  setBox(box, value);
  box.setSelectionRange(value.length, value.length);
  box.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
