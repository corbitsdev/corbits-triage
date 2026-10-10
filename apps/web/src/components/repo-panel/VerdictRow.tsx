import { Badge } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { applyRecommended, CATALOG_IDS, catalogCheckEnabled, type CheckPack, type CheckRef } from "@corbits/triage-contracts";
import type { TriageStats } from "../../lib/hub-api.ts";
import { setCatalogCheck, type RepoDraft } from "../../lib/pack-draft.ts";
import { checkName } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import CheckName from "./CheckName.tsx";
import Joined from "./Joined.tsx";

type VerdictRowProps = { draft: RepoDraft; saved: CheckPack; stats: TriageStats | undefined; disabled: boolean; edit: RepoPack["edit"]; reason?: string; flaggedCheck?: string };

/** The built-in action: every pull request gets the verdict of the checks that are on, posted as the posting mode says. */
export default function VerdictRow({ draft, saved, stats, disabled, edit, reason, flaggedCheck }: VerdictRowProps) {
  const pack = draft.pack;
  const on: CheckRef[] = [...CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)), ...pack.custom.map((row) => row.id as CheckRef)];
  const off = CATALOG_IDS.filter((id) => !catalogCheckEnabled(pack, id));
  const checks = on.map((id) => ({ key: id, node: <CheckName id={id} draft={draft} saved={saved} stats={stats} disabled={disabled} edit={edit} flagged={id === flaggedCheck} /> }));
  const posting = draft.policy.cleanupMode === "automated" ? "post the verdict automatically" : "post the verdict once you approve it";
  return (
    <div className={reason ? "act verdict-row invalid" : "act verdict-row"} id="rp-verdict">
      <div className="sentence">
        <p className="prose">
          <b>Every pull request</b>
          {checks.length ? <>, check <Joined items={checks} joiner="and" />, then {posting}.</> : <>: no checks are on, so there is no verdict to post.</>}
          {" "}
          <Menu>
            <MenuTrigger asChild><button type="button" className="linkish" disabled={disabled || off.length === 0}>Add check</button></MenuTrigger>
            <MenuContent align="start">
              {off.map((id) => <MenuItem key={id} onSelect={() => edit((current) => setCatalogCheck(current, saved, id, { enabled: true }))}>{checkName(pack, id)}</MenuItem>)}
            </MenuContent>
          </Menu>
        </p>
        <Badge tone="neutral">Built in</Badge>
        <Menu>
          <MenuTrigger asChild><button type="button" className="btn btn-quiet btn-sm icon" aria-label="More for the verdict" disabled={disabled}>⋯</button></MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => edit((current) => ({ ...current, pack: applyRecommended(current.pack) }))}>Reset to recommended</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {reason ? <p className="reason">{reason}</p> : null}
    </div>
  );
}
