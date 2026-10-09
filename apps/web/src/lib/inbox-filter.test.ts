import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import { NO_FILTERS, facetOptions, filtersFromParams, filtersToParams, matchesFilters } from "./inbox-filter.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function item(key: string, repo: string, owner: string | null, waitingSince: string): PrItem {
  return { key, repo, owner, waitingSince, author: "ada" } as PrItem;
}

const ITEMS = [
  item("a", "acme/api", "@acme/core", "2026-10-09T08:00:00.000Z"),
  item("b", "acme/api", null, "2026-10-05T12:00:00.000Z"),
  item("c", "acme/web", null, "2026-09-01T12:00:00.000Z"),
];

describe("inbox filters", () => {
  test("widen within a facet, narrow across facets, and count each facet against the others only", () => {
    const filters = { ...NO_FILTERS, repo: ["acme/api", "acme/web"], owner: ["Unassigned"] };
    expect(ITEMS.filter((row) => matchesFilters(row, filters, NOW)).map((row) => row.key)).toEqual(["b", "c"]);
    expect(facetOptions(ITEMS, filters, "repo", NOW)).toEqual([
      { value: "acme/api", label: "acme/api", count: 1 },
      { value: "acme/web", label: "acme/web", count: 1 },
    ]);
    expect(facetOptions(ITEMS, filters, "owner", NOW).map((option) => [option.value, option.count])).toEqual([["@acme/core", 1], ["Unassigned", 2]]);
    expect(facetOptions(ITEMS, NO_FILTERS, "age", NOW).map((option) => [option.label, option.count])).toEqual([["Under a day", 1], ["1 to 7 days", 1], ["Over a week", 1]]);
  });

  test("round-trip through the URL, keeping other parameters and dropping unknown ages", () => {
    const params = filtersToParams({ ...NO_FILTERS, repo: ["acme/api"], age: ["week"] }, new URLSearchParams("q=1&age=old"));
    expect(params.toString()).toBe("q=1&repo=acme%2Fapi&age=week");
    expect(filtersFromParams(new URLSearchParams("repo=acme%2Fapi&age=forever"))).toEqual({ ...NO_FILTERS, repo: ["acme/api"] });
  });
});
