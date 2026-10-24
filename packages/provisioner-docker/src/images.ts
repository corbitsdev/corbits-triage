import { type } from "arktype";
import type { DockerEngine } from "./engine.js";

// A pull's response lasts until every layer is downloaded, far past an ordinary request's timeout.
const PULL_TIMEOUT_MS = 10 * 60_000;

const PullProgress = type({ "error?": "string" }).array();

/** Pulls `image` onto the daemon; a pull reports failure in its progress, not its status. */
export async function pullDockerImage(engine: DockerEngine, image: string): Promise<void> {
  const progress = PullProgress.assert(await engine.request("POST", `/images/create?fromImage=${encodeURIComponent(image)}`, { timeoutMs: PULL_TIMEOUT_MS, lines: true }));
  const failed = progress.find((line) => line.error !== undefined);
  if (failed !== undefined) throw new Error(`Docker could not pull ${image} (${String(failed.error)}); pull it with docker pull ${image}`);
}
