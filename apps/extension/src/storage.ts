import type { CheckPack } from "@corbits/triage-contracts";
import { storage } from "@wxt-dev/storage";
import type { KeptPolicyFile } from "./policy-source.ts";
import { prKey, type PrRef } from "./pr.ts";
import type { SystemOneSettings } from "./system-one.ts";
import type { TriageView } from "./view.ts";

export type RunState = {
  running: boolean;
  error?: string;
  at: string;
};

const MAX_VIEWS = 200;

export const views = storage.defineItem<Record<string, TriageView>>("local:runs", { fallback: {} });
export const runStates = storage.defineItem<Record<string, RunState>>("local:run-states", { fallback: {} });
export const localPacks = storage.defineItem<Record<string, CheckPack>>("local:packs", { fallback: {} });
export const policyFiles = storage.defineItem<Record<string, KeptPolicyFile>>("local:policy-files", { fallback: {} });
export const systemOne = storage.defineItem<SystemOneSettings | null>("local:system-one", { fallback: null });
/** The person's own GitHub token; every read is made with it. Only the background reads it. */
export const githubToken = storage.defineItem<string | null>("local:github-token", { fallback: null });
/** Whether a token is saved, for the side panel, so no page but the background reads the token itself. */
export const tokenSaved = storage.defineItem<boolean>("local:token-saved", { fallback: false });

let writes: Promise<unknown> = Promise.resolve();

async function after(previous: Promise<unknown>, write: () => Promise<void>): Promise<void> {
  try {
    await previous;
  } catch {
    // A failed write is reported to its own caller; the next one still runs.
  }
  await write();
}

/** Runs of different pull requests finish together, so read-modify-write of the shared maps goes one at a time. */
function serialized(write: () => Promise<void>): Promise<void> {
  const next = after(writes, write);
  writes = next;
  return next;
}

export function saveView(view: TriageView): Promise<void> {
  return serialized(async function writeView() {
    const all = await views.getValue();
    const next = { ...all, [prKey(view.pr)]: view };
    const newest = Object.entries(next).sort(([, a], [, b]) => b.ranAt.localeCompare(a.ranAt)).slice(0, MAX_VIEWS);
    await views.setValue(Object.fromEntries(newest));
  });
}

export function setRunState(pr: PrRef, state: Omit<RunState, "at">): Promise<void> {
  return serialized(async function writeRunState() {
    const all = await runStates.getValue();
    await runStates.setValue({ ...all, [prKey(pr)]: { ...state, at: new Date().toISOString() } });
  });
}

export function keepPolicyFile(repo: string, kept: KeptPolicyFile): Promise<void> {
  return serialized(async function writePolicyFile() {
    await policyFiles.setValue({ ...(await policyFiles.getValue()), [repo]: kept });
  });
}

/** No run outlives the worker that started it, so a new worker clears what an old one left running. */
export function clearRunning(): Promise<void> {
  return serialized(async function writeCleared() {
    const all = await runStates.getValue();
    await runStates.setValue(Object.fromEntries(Object.entries(all).filter(([, state]) => !state.running)));
  });
}
