import { readFile } from "node:fs/promises";
import path from "node:path";

/** The token in `tokenFile`, or on standard input when no file is named. */
export async function readToken(tokenFile: string | undefined): Promise<string> {
  const token = (tokenFile === undefined ? await Bun.stdin.text() : await readFile(tokenFile, "utf8")).trim();
  if (token === "") throw new Error("No token: pass --token-file <file> or pipe it on standard input");
  return token;
}

/** Runs `suite` under `bun test` with `input` on standard input, so no secret is in its arguments or environment. */
export async function runSuite(suite: string, input: Record<string, string>): Promise<void> {
  const child = Bun.spawn(["bun", "--conditions=intx-src", "test", `./${path.relative(process.cwd(), path.join(import.meta.dir, suite))}`], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
