import { expect, test } from "bun:test";
import { ageText, formatDuration, relativeTime } from "./duration.ts";

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const BASE_ISO = new Date(BASE).toISOString();

test("each unit rolls over one millisecond past its limit", () => {
  expect(formatDuration(59_999)).toBe("59s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(24 * 3_600_000)).toBe("24h");
  expect(formatDuration(24 * 3_600_000 + 1)).toBe("1d");
  expect(relativeTime(BASE_ISO, BASE + 29 * 86_400_000)).toBe("1mo ago");
  expect(ageText(BASE_ISO, BASE + 29 * 86_400_000)).toBe("1mo");
});

test("missing or unparseable times read as unknown, and a future time clamps to 0s", () => {
  expect(relativeTime(null, BASE)).toBe("unknown time");
  expect(relativeTime("garbage", BASE)).toBe("unknown time");
  expect(ageText("garbage", BASE)).toBe("");
  expect(relativeTime(new Date(BASE + 10_000).toISOString(), BASE)).toBe("0s ago");
});
