import { parseArgs } from "node:util";
import { readToken, runSuite } from "./run-suite.js";

const { values } = parseArgs({
  options: {
    "token-file": { type: "string" },
    environment: { type: "string" },
    commit: { type: "string" },
  },
  strict: true,
});
const { environment, commit } = values;
if (environment === undefined || commit === undefined) {
  throw new Error("Usage: bun e2e/provisioners/railway.ts [--token-file <file holding a Railway workspace token>] --environment <environment id> --commit <pushed commit>");
}

await runSuite("railway.suite.ts", { token: await readToken(values["token-file"]), environmentId: environment, commit });
