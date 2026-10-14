import type { CheckPack } from "@corbits/triage-contracts";
import { storage } from "@wxt-dev/storage";
import { prKey, type PrRef } from "./pr.ts";
import type { SystemOneSettings } from "./system-one.ts";
import type { TriageView } from "./view.ts";

export type RunState = {
  running: boolean;
  error?: string;
  /** When GitHub's hourly limit, which stopped the last attempt, resets. */
  resetAt?: string;
  /** May be newer than the last successful run's. */
  head?: string;
  at: string;
};

const MAX_VIEWS = 200;
const MAX_APPLIED = 500;

export const views = storage.defineItem<Record<string, TriageView>>("local:views", { fallback: {} });
export const runStates = storage.defineItem<Record<string, RunState>>("local:run-states", { fallback: {} });
export const localPacks = storage.defineItem<Record<string, CheckPack>>("local:packs", { fallback: {} });
export const systemOne = storage.defineItem<SystemOneSettings | null>("local:system-one", { fallback: null });
/** The person's own GitHub token, for GitHub's 5,000 calls an hour instead of 60 without one. */
export const githubToken = storage.defineItem<string | null>("local:github-token", { fallback: null });
export type PageLayout = "sidebar" | "inline" | "banner" | "top-bar" | "composer";
export const PAGE_LAYOUTS: PageLayout[] = ["sidebar", "inline", "banner", "top-bar", "composer"];
export const pageLayout = storage.defineItem<PageLayout>("local:page-layout", { fallback: "sidebar" });
/**
 * What Triage already put in one of GitHub's fields or pickers on its own, by `offerKey`, so it never does it twice on
 * a pull request, whether the person kept it, posted it, cleared it or took it back out.
 */
export const seedsOffered = storage.defineItem<Record<string, string>>("local:seeds-offered", { fallback: {} });
export const tourPending = storage.defineItem<string | null>("local:tour", { fallback: null });
export const autoApply = storage.defineItem<Record<string, boolean>>("local:auto-apply", { fallback: {} });

export const commentFooter = storage.defineItem<boolean>("local:commentFooter", { fallback: true });

/** An action applied on GitHub from the page, by `actionKey`; `post` when a comment was posted rather than put in the box. */
export type Applied = { state: "applying" | "done" | "failed"; error?: string; post?: boolean; at: string };
export const appliedActions = storage.defineItem<Record<string, Applied>>("local:applied", { fallback: {} });

export const onboarded = storage.defineItem<boolean>("local:onboarded", { fallback: false });

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

// An apply still marked running after this long died with its page, so it counts as never tried.
const APPLY_STALE_MS = 60_000;

/** Unless it is an apply its page did not live to finish. */
export function liveApplied(applied: Applied | undefined): Applied | undefined {
  return applied?.state === "applying" && Date.now() - Date.parse(applied.at) > APPLY_STALE_MS ? undefined : applied;
}

export function actionKey(pr: PrRef, actionId: string): string {
  return `${prKey(pr)} ${actionId}`;
}

export function setApplied(key: string, applied: Omit<Applied, "at">): Promise<void> {
  return serialized(async function writeApplied() {
    const all = { ...(await appliedActions.getValue()), [key]: { ...applied, at: new Date().toISOString() } };
    const newest = Object.entries(all).sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, MAX_APPLIED);
    await appliedActions.setValue(Object.fromEntries(newest));
  });
}

const MAX_OFFERED = 500;

export function offerKey(pr: PrRef, what: string): string {
  return `${prKey(pr)} ${what}`;
}

export function setOffered(key: string): Promise<void> {
  return serialized(async function writeOffered() {
    const all = { ...(await seedsOffered.getValue()), [key]: new Date().toISOString() };
    await seedsOffered.setValue(Object.fromEntries(Object.entries(all).sort(([, a], [, b]) => b.localeCompare(a)).slice(0, MAX_OFFERED)));
  });
}

/** No run outlives the worker that started it, so a new worker clears what an old one left running. */
export function clearRunning(): Promise<void> {
  return serialized(async function writeCleared() {
    const all = await runStates.getValue();
    await runStates.setValue(Object.fromEntries(Object.entries(all).filter(([, state]) => !state.running)));
  });
}
