import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starterPack } from "./check-pack.ts";
import { exportPolicyFile } from "./policy-export.ts";
import { checkPolicyFile } from "./policy-file.ts";

const REPO = "acme/widgets";
const REFERENCE = readFileSync(join(import.meta.dir, "../../../skills/corbits-triage-setup/reference.md"), "utf8");

/** The first yaml block under a `## heading` of the setup skill's reference. */
function yamlUnder(heading: string): string {
  const section = REFERENCE.split(`\n## ${heading}\n`)[1];
  const block = section?.match(/```yaml\n([\s\S]*?)```/)?.[1];
  if (block === undefined) throw new Error(`No yaml block under ${heading}.`);
  return block;
}

test("the setup skill's starter file is the starter policy, and its extras and blocks are valid with it", () => {
  const starter = yamlUnder("Starter file");
  const exported = checkPolicyFile(exportPolicyFile(starterPack(REPO), false).text, REPO);
  expect(checkPolicyFile(starter, REPO)).toEqual(exported);
  expect(checkPolicyFile(`${starter}${yamlUnder("Extras, written out")}`, REPO)).toMatchObject({ ok: true });
  expect(checkPolicyFile(`${starter}${yamlUnder("Blocks and decide")}`, REPO)).toMatchObject({ ok: true });
});
