import { fakeBrowser } from "wxt/testing/fake-browser";

// @wxt-dev/browser takes the global when it is first imported, so tests import this before storage.ts.
Object.assign(globalThis, { browser: fakeBrowser });

export { fakeBrowser };
