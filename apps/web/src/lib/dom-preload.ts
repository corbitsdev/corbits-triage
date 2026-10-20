import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Preloaded for the *.dom.test.tsx files, which run in a process of their own: Radix and React DOM look for a
// document once, when they load, and the browser globals would break the tests that need Node's own fetch.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
