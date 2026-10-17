import { describe, expect, test } from "bun:test";
import { AUTHOR_GROUPS, emptyPack, readCheckPack, type AuthorGroup } from "@corbits/triage-contracts";
import { forChoice, withFor } from "./policy-view.ts";

describe("for", () => {
  test.each(Object.keys(AUTHOR_GROUPS) as AuthorGroup[])("a stored step for %s shows as it, and choosing it again keeps the same authors", (group) => {
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), actions: { when: ["opened"], pass: [{ do: "approve", for: group }], fail: [], unsure: [] } });
    const step = pack.actions.pass[0]!;
    expect(forChoice(step)).toBe(group);
    expect(withFor(step, group)).toEqual(step);
  });

  test("a stored step for several groups shows its first group, as before", () => {
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), actions: { when: ["opened"], pass: [
      { do: "approve", when: { author: ["external", "bots"] } },
      { do: "approve", when: { author: ["maintainers", { team: "acme/core" }] } },
      { do: "approve", when: { author: ["first-timers", "bots"] } },
    ], fail: [], unsure: [] } });
    expect(pack.actions.pass.map(forChoice)).toEqual(["external", "maintainers", "first-timers"]);
  });

  test("a step for one kind shows as that kind", () => {
    expect(forChoice({ do: "approve", when: { author: ["OWNER"] } })).toBe("OWNER");
    expect(withFor({ do: "approve" }, "FIRST_TIMER")).toEqual({ do: "approve", when: { author: ["FIRST_TIMER"] } });
  });
});
