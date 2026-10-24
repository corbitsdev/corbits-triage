import { expect, test } from "bun:test";
import { linesOf } from "./lines";

const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");

test("refuses a range that starts before line 1 or ends before it starts", () => {
  for (const [start, end] of [[1, -1], [-5, 10], [20, 10], [0, 10]] as const) {
    expect(() => linesOf("big.txt", text, start, end)).toThrow("lines are 1-based and end must be at least start");
  }
});
