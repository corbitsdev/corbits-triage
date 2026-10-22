import { errorText } from "@corbits/common";
import type { PrRef } from "./pr.ts";

/** The background worker makes every network call but a github.com tab's own reads, and is the only part that reads the token. */
export type Request =
  | { type: "open-panel" }
  /** `if-stale` reuses a recent run; `refetch` reads GitHub and the policy file again. */
  | { type: "triage"; pr: PrRef; mode: "if-stale" | "refetch" }
  | { type: "save-token"; token: string }
  | { type: "remove-token" };

/** From the background to a github.com tab: the API's JSON for `path`, read through the page as the person signed in. */
export type TabRequest = { type: "session-read"; run: string; path: string };

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export async function ask(request: Request): Promise<null> {
  const reply = (await browser.runtime.sendMessage(request)) as Reply<null> | undefined;
  if (!reply) throw new Error("The extension's background worker did not answer.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/** For a message whose answer nothing waits on; a failure is logged, never thrown into an event handler. */
export async function send(request: Request): Promise<void> {
  try {
    await ask(request);
  } catch (cause) {
    console.warn(errorText(cause));
  }
}
