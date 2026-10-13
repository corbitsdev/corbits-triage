import { evaluate } from "@corbits/system-one";
import type { JudgeChunk } from "@corbits/triage-workflows/actions/rules";
import { errorText } from "./error-text.ts";

/** A decision model as the portal saves one: a System One–compatible base URL, its model and the key for it. */
export type SystemOneSettings = { endpoint: string; model: string; key: string };

function systemOneUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/systemone`;
}

// A whole pull request's state can take the decision model several seconds; the package default is 1.5 s.
const TIMEOUT_MS = 60_000;

function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

/**
 * The client's default deps call `deps.fetch(...)` on the global fetch it captured, which a browser refuses
 * ("Illegal invocation"), so the extension hands it a plain function and its own timer.
 */
const BROWSER_DEPS = {
  fetch: browserFetch,
  scheduler: {
    setTimeout(callback: () => void, delayMs: number) {
      const handle = setTimeout(callback, delayMs);
      return function cancel() {
        clearTimeout(handle);
      };
    },
    now() {
      return Date.now();
    },
  },
};

/** One chunk's reply as the judge step records it: the decisions as concatenated JSON, or why there are none. */
export async function askChunk(chunk: JudgeChunk, settings: SystemOneSettings): Promise<{ judge: string } | { judgeError: string }> {
  let result: Awaited<ReturnType<typeof evaluate>>;
  try {
    result = await evaluate({
      state: chunk.state,
      questions: chunk.questions,
      config: { endpoint: { kind: "custom", url: systemOneUrl(settings.endpoint), model: settings.model }, apiKey: settings.key, timeoutMs: TIMEOUT_MS },
    }, { deps: BROWSER_DEPS });
  } catch (cause) {
    // Only input the client refuses throws; like an outage, it leaves this chunk's checks unanswered.
    return { judgeError: errorText(cause) };
  }
  if (result.fallback) return { judgeError: result.detail ? `${result.reason}: ${result.detail}` : result.reason };
  return { judge: result.decisions.map((decision) => JSON.stringify(decision)).join("") };
}
