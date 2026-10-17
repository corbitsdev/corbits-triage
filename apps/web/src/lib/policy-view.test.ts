import { describe, expect, test } from "bun:test";
import { AUTHOR_GROUPS, emptyPack, readCheckPack, type AuthorGroup } from "@corbits/triage-contracts";
import { forChoice } from "./policy-view.ts";

describe("for", () => {
  test.each(Object.keys(AUTHOR_GROUPS) as AuthorGroup[])("a stored step for %s shows as it", (group) => {
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), actions: { when: ["opened"], pass: [{ do: "approve", for: group }], fail: [], unsure: [] } });
    expect(forChoice(pack.actions.pass[0]!)).toBe(group);
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
  });
});
