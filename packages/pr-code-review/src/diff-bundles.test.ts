import { describe, expect, test } from "bun:test";
import { splitBundle, MAX_BUNDLE_BYTES } from "./diff-parts.js";
import { promptText } from "./prompt-text.js";

describe("finder bundle bounds", () => {
  test("caps the entire escaped message and reconstructs in order", () => {
    const patch = "<diff>é😀\n".repeat(30_000);
    function message(text: string) {
      return `<diff path="src/a.ts">\n${promptText(text)}\n</diff>`;
    }
    const pieces = splitBundle(patch, message);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(patch);
    expect(pieces.every((piece) => Buffer.byteLength(message(piece)) <= MAX_BUNDLE_BYTES)).toBe(true);
    expect(pieces.some((piece) => piece.includes("�"))).toBe(false);
  });

  test("keeps a fitting patch together", () => {
    expect(splitBundle("a\né\n", String, 6)).toEqual(["a\né\n"]);
  });

  test("zero room and an indivisible multibyte character throw rather than stall", () => {
    expect(() => splitBundle("a", String, 0)).toThrow();
    expect(() => splitBundle("é", String, 1)).toThrow();
    expect(() => splitBundle("😀", String, 3)).toThrow();
  });

  test("escaping growth cannot stall when even one character cannot fit", () => {
    function escaped(text: string) {
      return text.replaceAll("<", "\\u003c");
    }
    expect(() => splitBundle("<", escaped, 5)).toThrow();
    expect(splitBundle("<<", escaped, 6)).toEqual(["<", "<"]);
  });

  test("long UTF-8 lines split losslessly and oversized overhead throws", () => {
    const patch = "é😀".repeat(30);
    const pieces = splitBundle(patch, String, 7);
    expect(pieces.join("")).toBe(patch);
    expect(pieces.every((piece) => Buffer.byteLength(piece) <= 7)).toBe(true);
    function message(text: string) {
      return `overhead${text}`;
    }
    expect(() => splitBundle("", message, 7)).toThrow();
  });
});
