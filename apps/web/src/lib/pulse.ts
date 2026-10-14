import type { PrItem } from "./hub-api.ts";
import { repoOf, waitsOn, type OpenItem } from "./inbox-view.ts";

/** Waiting on the maintainer longer than this makes a pull request stuck. `waitingSince` restarts with every new verdict, as in the inbox's age filter. */
const STUCK_MS = 3 * 86_400_000;

/** A pull request as it stood when the last visit ended; `you` is whether it waited on the maintainer. */
type VisitPull = { title: string | null; you: boolean };

/**
 * The open pull requests when the last visit ended. GitHub gives no opened or closed time, so what changed is the difference to this.
 * `repos` lists the repositories that had triage on and that GitHub answered for; only their pull requests are compared.
 */
export type Visit = { at: string; repos: string[]; pulls: Record<string, VisitPull> };

export type ResolvedPull = { key: string; repo: string; number: number; title: string | null };

export type SinceVisit = { fresh: PrItem[]; resolved: ResolvedPull[]; turned: PrItem[] };

function waitsOnYou(entry: OpenItem): boolean {
  return waitsOn(entry.item, entry.handled) === "maintainer";
}

export function visitOf(open: OpenItem[], read: ReadonlySet<string>, now: Date): Visit {
  const pulls = Object.fromEntries(open
    .filter((entry) => read.has(entry.item.repo))
    .map((entry) => [entry.item.key, { title: entry.item.title, you: waitsOnYou(entry) }]));
  return { at: now.toISOString(), repos: [...read], pulls };
}

/**
 * New: open now and not at the last visit, in a repository compared both times. Resolved: open at the last visit and no longer open,
 * in a repository GitHub just answered for. Turned to you: open both times and waiting on the maintainer now but not then.
 */
export function sinceVisit(visit: Visit, open: OpenItem[], read: ReadonlySet<string>): SinceVisit {
  const before = new Set(visit.repos);
  const now = new Map(open.map((entry) => [entry.item.key, entry]));
  const fresh = open.filter((entry) => before.has(entry.item.repo) && read.has(entry.item.repo) && !Object.hasOwn(visit.pulls, entry.item.key));
  const turned = open.filter((entry) => visit.pulls[entry.item.key]?.you === false && waitsOnYou(entry));
  const resolved = Object.entries(visit.pulls)
    .filter(([key]) => read.has(repoOf(key)) && !now.has(key))
    .map(([key, pull]) => ({ key, repo: repoOf(key), number: Number(key.slice(key.lastIndexOf("#") + 1)), title: pull.title }));
  return { fresh: fresh.map((entry) => entry.item), resolved, turned: turned.map((entry) => entry.item) };
}

export function stuckPulls(open: OpenItem[], now: number): PrItem[] {
  return open
    .filter((entry) => entry.item.waitingSince !== null && waitsOnYou(entry) && now - Date.parse(entry.item.waitingSince) > STUCK_MS)
    .map((entry) => entry.item)
    .sort((a, b) => Date.parse(a.waitingSince ?? "") - Date.parse(b.waitingSince ?? ""));
}

/** Saved within this long, a visit carries on after a reload or a restored tab. */
export const CONTINUE_MS = 10 * 60_000;

/**
 * What is kept per user: the visit compared to, what was open at the last save, and what was acted on since the compared visit.
 * `first` marks a compared visit that started on the user's first visit, so nothing can have changed yet.
 */
export type SavedPulse = { compared: Visit; latest: Visit; acted: string[]; first: boolean };

export type VisitStart = Pick<SavedPulse, "compared" | "acted" | "first">;

/** Saved within `CONTINUE_MS`, the visit carries on; saved earlier, that save is what the new visit is compared to. */
export function resumeVisit(saved: SavedPulse, now: number): VisitStart {
  if (now - Date.parse(saved.latest.at) < CONTINUE_MS) return { compared: saved.compared, acted: saved.acted, first: saved.first };
  return { compared: saved.latest, acted: [], first: false };
}

function isVisitPull(value: unknown): value is VisitPull {
  if (typeof value !== "object" || value === null) return false;
  const pull = value as Record<string, unknown>;
  return (pull.title === null || typeof pull.title === "string") && typeof pull.you === "boolean";
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function visitFrom(value: unknown): Visit | null {
  if (typeof value !== "object" || value === null) return null;
  const visit = value as Record<string, unknown>;
  if (typeof visit.at !== "string" || !isStrings(visit.repos)) return null;
  if (typeof visit.pulls !== "object" || visit.pulls === null || !Object.values(visit.pulls).every(isVisitPull)) return null;
  return { at: visit.at, repos: visit.repos, pulls: visit.pulls as Record<string, VisitPull> };
}

export function parseSavedPulse(text: string | null): SavedPulse | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const saved = value as Record<string, unknown>;
    const compared = visitFrom(saved.compared);
    const latest = visitFrom(saved.latest);
    if (compared === null || latest === null || !isStrings(saved.acted) || typeof saved.first !== "boolean") return null;
    return { compared, latest, acted: saved.acted, first: saved.first };
  } catch {
    return null;
  }
}
