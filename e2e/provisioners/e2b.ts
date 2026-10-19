import { parseArgs } from "node:util";
import { readToken, runSuite } from "./run-suite.js";

const { values } = parseArgs({ options: { "token-file": { type: "string" } }, strict: true });

await runSuite("e2b.suite.ts", { apiKey: await readToken(values["token-file"]) });
