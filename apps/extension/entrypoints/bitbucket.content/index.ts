import "../github.content/style.css";
import "./style.css";
import { startBitbucketContentScript } from "../../src/content/bitbucket.ts";

// Spike: the local Data Center instance only; a real build registers each instance the person grants at runtime.
export default defineContentScript({
  matches: ["http://localhost:7990/*"],
  cssInjectionMode: "ui",
  main(ctx) {
    return startBitbucketContentScript(ctx);
  },
});
