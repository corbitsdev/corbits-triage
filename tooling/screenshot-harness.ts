import { fixtures } from "../packages/triage-contracts/src/fixtures.js";
import type { PRRecord } from "../packages/triage-contracts/src/types.js";
import { triage } from "./facts.js";

const outDir = `${import.meta.dir}/shots`;
await Bun.$`mkdir -p ${outDir}`.quiet();

function outcomeOf(pr: PRRecord) {
  const r = triage(pr);
  return { pr: pr.id, state: r.state, owner: r.owner, humanGated: r.humanGated };
}

const outcomes = fixtures.slice(0, 5).map(outcomeOf);
await Bun.write(`${outDir}/triage-snapshot.json`, JSON.stringify({ outcomes }, null, 2));
console.log(`screenshot harness: wrote ${outDir}/triage-snapshot.json (${outcomes.length} PRs)`);
