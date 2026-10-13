import { startBackground } from "../src/background.ts";

// Entrypoints stay thin: WXT imports them at build time to read their options, and drops what only main uses.
export default defineBackground(function main() {
  startBackground();
});
