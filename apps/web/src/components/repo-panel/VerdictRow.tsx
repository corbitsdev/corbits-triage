import { Badge } from "@corbits/react-ui";
import { CATALOG_IDS, type CheckRef, type TriageStats } from "@corbits/triage-contracts";
import { checkOn, type RepoDraft } from "../../lib/pack-draft.ts";
import CheckName from "./CheckName.tsx";
import Joined from "./Joined.tsx";

type VerdictRowProps = { draft: RepoDraft; stats: TriageStats | undefined };

/** The built-in action: every pull request gets the verdict of the checks that are on. */
export default function VerdictRow({ draft, stats }: VerdictRowProps) {
  const pack = draft.pack;
  const on = [...CATALOG_IDS, ...pack.custom.map((row) => row.id as CheckRef)].filter((id) => checkOn(pack, id));
  const checks = on.map((id) => ({ key: id, node: <CheckName id={id} draft={draft} stats={stats} /> }));
  return (
    <div className="act verdict-row" id="rp-verdict">
      <div className="sentence">
        <p className="prose">
          <b>Every pull request</b>
          {checks.length ? <>, check <Joined items={checks} joiner="and" />, then post the verdict.</> : <>: no checks are on, so there is no verdict to post.</>}
        </p>
        <Badge tone="neutral">Built in</Badge>
      </div>
    </div>
  );
}
