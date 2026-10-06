// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import type { LastCycleSource } from "@intx/types/runtime";
import {
  createNullTolerantOpenAIAdapter,
  normalizeNullDeltaPayload,
} from "./null-delta.js";

const SOURCE: LastCycleSource = {
  sourceId: "src-null-delta-fixture",
  provider: "openai-compatible",
  model: "glm-5.3-flash",
};

const NULL_ROLE_CHUNK = JSON.stringify({
  choices: [
    {
      index: 0,
      delta: { role: null, content: "hello", tool_calls: null },
      finish_reason: null,
    },
  ],
});

const STOCK_SHAPED_CHUNK = JSON.stringify({
  choices: [
    { index: 0, delta: { role: "assistant", content: "hi" } },
  ],
});

describe("normalizeNullDeltaPayload", () => {
  test("deletes explicit-null role and tool_calls", () => {
    const out = JSON.parse(normalizeNullDeltaPayload(NULL_ROLE_CHUNK)) as {
      choices: { delta: Record<string, unknown> }[];
    };
    expect(out.choices[0]?.delta).toEqual({ content: "hello" });
  });

  test("stock-shaped and unparsable payloads pass through byte-identical", () => {
    expect(normalizeNullDeltaPayload(STOCK_SHAPED_CHUNK)).toBe(STOCK_SHAPED_CHUNK);
    expect(normalizeNullDeltaPayload("not-json[")).toBe("not-json[");
  });
});

describe("createNullTolerantOpenAIAdapter", () => {
  test("decodes the null-delta text chunk", () => {
    const events = createNullTolerantOpenAIAdapter(SOURCE).parseResponse(NULL_ROLE_CHUNK);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("inference.text.delta");
    if (event?.type === "inference.text.delta") {
      expect(event.data.token).toBe("hello");
    }
  });
});
