import "./style.css";
import { startContentScript } from "../../src/content/index.ts";

export default defineContentScript({
  matches: ["https://github.com/*"],
  cssInjectionMode: "ui",
  main(ctx) {
    return startContentScript(ctx);
  },
});
