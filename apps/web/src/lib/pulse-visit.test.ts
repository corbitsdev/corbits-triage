import { expect, test } from "bun:test";
import { forgetSavedVisits } from "./pulse-visit.tsx";

test("forgetting saved visits keeps other per-user choices", () => {
  const items = new Map([["corbits-triage:pulse:a:t1", "{}"], ["corbits-triage:diff-layout:a", "split"]]);
  const storage = {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
  } as Storage;

  forgetSavedVisits(storage);

  expect([...items.keys()]).toEqual(["corbits-triage:diff-layout:a"]);
});
