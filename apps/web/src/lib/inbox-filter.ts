import type { PrItem } from "./hub-api.ts";
import { UNASSIGNED } from "./inbox-view.ts";

export type FilterFacet = "repo" | "owner" | "author" | "age";

export const FILTER_FACETS: FilterFacet[] = ["repo", "owner", "author", "age"];

export const FACET_LABEL: Record<FilterFacet, string> = { repo: "Repository", owner: "Owner", author: "Author", age: "Age" };

type AgeBucket = "day" | "week" | "older";

const AGE_LABEL: Record<AgeBucket, string> = { day: "Under a day", week: "1 to 7 days", older: "Over a week" };

const AGE_BUCKETS = Object.keys(AGE_LABEL) as AgeBucket[];

const DAY_MS = 86_400_000;

/** The selected values per facet; values inside one facet widen the match, facets narrow it. */
export type InboxFilters = Record<FilterFacet, string[]>;

export type FilterOption = { value: string; label: string; count: number };

export type ActiveFilter = { facet: FilterFacet; value: string; label: string };

function ageBucket(waitingSince: string | null, now: number): AgeBucket | null {
  if (waitingSince === null) return null;
  const age = now - Date.parse(waitingSince);
  if (age < DAY_MS) return "day";
  return age <= 7 * DAY_MS ? "week" : "older";
}

function facetValue(item: PrItem, facet: FilterFacet, now: number): string | null {
  switch (facet) {
    case "repo":
      return item.repo;
    case "owner":
      return item.owner ?? UNASSIGNED;
    case "author":
      return item.author;
    case "age":
      return ageBucket(item.waitingSince, now);
  }
}

export function optionLabel(facet: FilterFacet, value: string): string {
  return facet === "age" ? AGE_LABEL[value as AgeBucket] : value;
}

export function matchesFilters(item: PrItem, filters: InboxFilters, now: number): boolean {
  return FILTER_FACETS.every(function facetMatches(facet) {
    const selected = filters[facet];
    if (selected.length === 0) return true;
    const value = facetValue(item, facet, now);
    return value !== null && selected.includes(value);
  });
}

function compareOwners(a: string, b: string): number {
  if (a === UNASSIGNED || b === UNASSIGNED) return Number(a === UNASSIGNED) - Number(b === UNASSIGNED);
  return a.localeCompare(b);
}

/** Every value the items hold for the facet, counted over the items that pass the other facets' filters. */
export function facetOptions(items: PrItem[], filters: InboxFilters, facet: FilterFacet, now: number): FilterOption[] {
  const others = { ...filters, [facet]: [] };
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = facetValue(item, facet, now);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + (matchesFilters(item, others, now) ? 1 : 0));
  }
  for (const value of filters[facet]) if (!counts.has(value)) counts.set(value, 0);
  const values = facet === "age" ? AGE_BUCKETS : [...counts.keys()].sort(facet === "owner" ? compareOwners : (a, b) => a.localeCompare(b));
  return values.map((value) => ({ value, label: optionLabel(facet, value), count: counts.get(value) ?? 0 }));
}

export function activeFilters(filters: InboxFilters): ActiveFilter[] {
  return FILTER_FACETS.flatMap((facet) => filters[facet].map((value) => ({ facet, value, label: optionLabel(facet, value) })));
}

export function toggleFilter(filters: InboxFilters, facet: FilterFacet, value: string): InboxFilters {
  const selected = filters[facet];
  return { ...filters, [facet]: selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value] };
}

export const NO_FILTERS: InboxFilters = { repo: [], owner: [], author: [], age: [] };

/** Unknown age buckets in a hand-edited link are dropped rather than matching nothing. */
export function filtersFromParams(params: URLSearchParams): InboxFilters {
  function read(facet: FilterFacet): string[] {
    return [...new Set(params.getAll(facet).filter(Boolean))];
  }
  return { repo: read("repo"), owner: read("owner"), author: read("author"), age: read("age").filter((value) => (AGE_BUCKETS as string[]).includes(value)) };
}

export function filtersToParams(filters: InboxFilters, params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const facet of FILTER_FACETS) {
    next.delete(facet);
    for (const value of filters[facet]) next.append(facet, value);
  }
  return next;
}
