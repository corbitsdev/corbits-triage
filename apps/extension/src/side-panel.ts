import { errorText } from "./error-text.ts";

// WXT's browser types follow Chrome's, which have no sidebarAction.
type FirefoxBrowser = { sidebarAction: { open(): Promise<void>; toggle(): Promise<void> } };

function sidebar() {
  return (browser as unknown as FirefoxBrowser).sidebarAction;
}

/** Chrome's side panel, or Firefox's sidebar; both open only inside a user gesture, so call this in the click's own turn. */
export async function openSidePanel(windowId: number): Promise<void> {
  if (import.meta.env.FIREFOX) return sidebar().open();
  await browser.sidePanel.open({ windowId });
}

async function toggleSidebar(): Promise<void> {
  try {
    await sidebar().toggle();
  } catch (cause) {
    console.warn(errorText(cause));
  }
}

/** The toolbar button opens the panel: Chrome does it itself once told to, Firefox needs the click handled. */
export async function openPanelOnActionClick(): Promise<void> {
  if (!import.meta.env.FIREFOX) return browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.action.onClicked.addListener(toggleSidebar);
}
