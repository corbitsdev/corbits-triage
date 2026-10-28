import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starterPack } from "./check-pack.ts";
import { exportPolicyFile } from "./policy-export.ts";
import { checkPolicyFile } from "./policy-file.ts";

const REPO = "acme/widgets";
const REFERENCE = readFileSync(join(import.meta.dir, "../../../skills/corbits-triage-setup/reference.md"), "utf8");

/** Every yaml block under a `## heading` of the setup skill's reference. */
function yamlUnder(heading: string): string[] {
  const section = REFERENCE.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  if (section === undefined) throw new Error(`No ${heading} section.`);
  const blocks = Array.from(section.matchAll(/```yaml\n([\s\S]*?)```/g), (match) => match[1] as string);
  if (blocks.length === 0) throw new Error(`No yaml block under ${heading}.`);
  return blocks;
}

test("the setup skill's starter file is the starter policy, and every other example is valid with it", () => {
  const [starter] = yamlUnder("Starter file") as [string];
  const exported = checkPolicyFile(exportPolicyFile(starterPack(REPO)).text, REPO);
  expect(checkPolicyFile(starter, REPO)).toEqual(exported);
  const [groups] = yamlUnder("Rules") as [string];
  const withGroups = starter.replace(/ {2}- check: sensitive-paths\n(?: {4}.*\n)+/, groups);
  expect(withGroups).not.toBe(starter);
  expect(checkPolicyFile(withGroups, REPO)).toMatchObject({ ok: true });
  for (const heading of ["Extras, written out", "Actions", "Labels", "Blocks and decide"]) {
    for (const block of yamlUnder(heading)) {
      expect(checkPolicyFile(`${starter}${block.replaceAll("<login>", "octocat")}`, REPO)).toMatchObject({ ok: true });
    }
  }
});
