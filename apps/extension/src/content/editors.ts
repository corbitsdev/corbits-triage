
// The description is the first comment on the Conversation tab.
const BODY_COMMENT = ".js-command-palette-pull-body";
const BODY_FIELD = 'textarea[name="pull_request[body]"]';
const LABEL_PICKER = 'form[aria-label="Select labels"]';

export const SIGN_IN = "Sign in to GitHub with write access to this repository to apply it.";

export function canTriage(): boolean {
  return document.querySelector(LABEL_PICKER) !== null;
}

function shown(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.getClientRects().length > 0;
}

export function openBodyField(): HTMLTextAreaElement | undefined {
  const field = document.querySelector(BODY_COMMENT)?.querySelector<HTMLTextAreaElement>(BODY_FIELD) ?? document.querySelector<HTMLTextAreaElement>(BODY_FIELD);
  return shown(field) ? field : undefined;
}

export function editBody(): void {
  if (openBodyField()) return;
  const edit = document.querySelector(BODY_COMMENT)?.querySelector<HTMLButtonElement>(".js-comment-edit-button");
  if (!edit) throw new Error(`Open the Conversation tab. ${SIGN_IN}`);
  edit.click();
}

export function markReady(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => /^ready for review$/i.test(each.textContent?.trim() ?? "") && !each.disabled);
  if (!button) throw new Error("Open the Conversation tab. Only the author or someone with write access, signed in, can mark it ready.");
  button.click();
}
