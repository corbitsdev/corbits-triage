// Runs the conformance suite against real Railway sandboxes. Not part of `bun run test`: it creates and destroys
// sandboxes, which costs money, so it runs only by hand (docs/provisioners/railway-sandboxes.md has the command).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "token-file": { type: "string" },
    environment: { type: "string" },
    commit: { type: "string" },
  },
  strict: true,
});
const tokenFile = values["token-file"];
const { environment, commit } = values;
if (tokenFile === undefined || environment === undefined || commit === undefined) {
  throw new Error("Usage: bun proof/live.ts --token-file <file holding a Railway workspace token> --environment <environment id> --commit <pushed commit>");
}

// The token reaches the suite on standard input, never in a process's arguments or environment.
const input = JSON.stringify({ token: (await readFile(tokenFile, "utf8")).trim(), environmentId: environment, commit });
const suite = Bun.spawn(["bun", "--conditions=intx-src", "test", `./${path.relative(process.cwd(), path.join(import.meta.dir, "live-conformance.ts"))}`], {
  stdin: new Blob([input]),
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await suite.exited;
