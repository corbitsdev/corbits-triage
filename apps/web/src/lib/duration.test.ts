import { describe, expect, test } from "bun:test";
import { ageText, formatDuration, relativeTime } from "./duration.ts";

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const BASE_ISO = new Date(BASE).toISOString();

describe("formatDuration ladder boundaries", () => {
  test.each([
    [0, "0s"],
    [45_000, "45s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [30 * 60_000, "30m"],
    [59 * 60_000, "59m"],
    [3_600_000, "1h"],
    [5 * 3_600_000, "5h"],
    [24 * 3_600_000, "24h"],
    [24 * 3_600_000 + 1, "1d"],
    [3 * 86_400_000, "3d"],
    [6 * 86_400_000, "6d"],
    [7 * 86_400_000, "7d"],
    [7 * 86_400_000 + 1, "1w"],
    [28 * 86_400_000, "4w"],
    [29 * 86_400_000, "1mo"],
    [5 * 2_592_000_000, "5mo"],
    [12 * 2_592_000_000, "12mo"],
    [12 * 2_592_000_000 + 1, "1y"],
    [2 * 31_104_000_000, "2y"],
  ])("formatDuration(%i) === %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("relativeTime", () => {
  test.each([
    [45_000, "45s ago"],
    [30 * 60_000, "30m ago"],
    [24 * 3_600_000, "24h ago"],
    [7 * 86_400_000, "7d ago"],
    [28 * 86_400_000, "4w ago"],
    [29 * 86_400_000, "1mo ago"],
    [12 * 2_592_000_000, "12mo ago"],
    [2 * 31_104_000_000, "2y ago"],
  ])("renders %i ms elapsed as %s", (delta, expected) => {
    expect(relativeTime(BASE_ISO, BASE + delta)).toBe(expected);
  });

  test("renders seven minutes back as raw minutes", () => {
    expect(relativeTime(BASE_ISO, BASE + 7 * 60_000)).toBe("7m ago");
  });

  test("clamps a negative delta to 0s", () => {
    expect(relativeTime(new Date(BASE + 10_000).toISOString(), BASE)).toBe("0s ago");
  });

  test("returns unknown time for null, empty, and garbage input", () => {
    expect(relativeTime(null, BASE)).toBe("unknown time");
    expect(relativeTime("", BASE)).toBe("unknown time");
    expect(relativeTime("garbage", BASE)).toBe("unknown time");
    expect(relativeTime(undefined, BASE)).toBe("unknown time");
  });
});

describe("ageText", () => {
  test.each([
    [45_000, "45s"],
    [30 * 60_000, "30m"],
    [24 * 3_600_000, "24h"],
    [7 * 86_400_000, "7d"],
    [28 * 86_400_000, "4w"],
    [29 * 86_400_000, "1mo"],
    [12 * 2_592_000_000, "12mo"],
    [2 * 31_104_000_000, "2y"],
  ])("renders %i ms elapsed as bare token %s", (delta, expected) => {
    expect(ageText(BASE_ISO, BASE + delta)).toBe(expected);
  });

  test("renders seven minutes back as raw minutes", () => {
    expect(ageText(BASE_ISO, BASE + 7 * 60_000)).toBe("7m");
  });

  test("clamps a negative delta to 0s", () => {
    expect(ageText(new Date(BASE + 10_000).toISOString(), BASE)).toBe("0s");
  });

  test("returns empty string for null and bad input", () => {
    expect(ageText(null, BASE)).toBe("");
    expect(ageText("", BASE)).toBe("");
    expect(ageText("garbage", BASE)).toBe("");
  });
});
