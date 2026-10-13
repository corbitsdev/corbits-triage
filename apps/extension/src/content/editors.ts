/** GitHub's own editors for a pull request's description and title, as its Conversation tab renders them signed in. */

// The description is the first comment on the Conversation tab.
const BODY_COMMENT = ".js-command-palette-pull-body";
const BODY_FIELD = 'textarea[name="pull_request[body]"]';
const LABEL_PICKER = 'form[aria-label="Select labels"]';

export const SIGN_IN = "Sign in to GitHub with write access to this repository to apply it.";

/** Someone GitHub lets triage the pull request sees its label picker in the sidebar. */
export function canTriage(): boolean {
  return document.querySelector(LABEL_PICKER) !== null;
}

function shown(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.getClientRects().length > 0;
}

/** The description's editor while it is open. */
export function openBodyField(): HTMLTextAreaElement | undefined {
  const field = document.querySelector(BODY_COMMENT)?.querySelector<HTMLTextAreaElement>(BODY_FIELD) ?? document.querySelector<HTMLTextAreaElement>(BODY_FIELD);
  return shown(field) ? field : undefined;
}

/** Opens the description's editor with GitHub's own Edit, there only for someone allowed to edit it. */
export function editBody(): void {
  if (openBodyField()) return;
  const edit = document.querySelector(BODY_COMMENT)?.querySelector<HTMLButtonElement>(".js-comment-edit-button");
  if (!edit) throw new Error(`Open the Conversation tab. ${SIGN_IN}`);
  edit.click();
}

/** GitHub's "Ready for review", which only the author or a maintainer sees on a draft. */
export function markReady(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => /^ready for review$/i.test(each.textContent?.trim() ?? "") && !each.disabled);
  if (!button) throw new Error("Open the Conversation tab. Only the author or someone with write access, signed in, can mark it ready.");
  button.click();
}
