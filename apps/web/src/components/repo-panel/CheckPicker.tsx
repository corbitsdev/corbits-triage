import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { CATALOG_IDS, CUSTOM_CHECK_CAP, type CheckPack, type CheckRef } from "@corbits/triage-contracts";
import type { TriageStats } from "../../lib/hub-api.ts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { checkName } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import CheckName from "./CheckName.tsx";

type CheckPickerProps = {
  checks: CheckRef[];
  draft: RepoDraft;
  saved: CheckPack;
  stats: TriageStats | undefined;
  disabled: boolean;
  edit: RepoPack["edit"];
  onChange: (checks: CheckRef[]) => void;
  onNewCheck: () => void;
};

/** The checks whose combined verdict picks the branch, chosen by name or created new. */
export default function CheckPicker({ checks, draft, saved, stats, disabled, edit, onChange, onNewCheck }: CheckPickerProps) {
  const pack = draft.pack;
  const all: CheckRef[] = [...CATALOG_IDS, ...pack.custom.map((row) => row.id as CheckRef)];
  const rest = all.filter((id) => !checks.includes(id));
  const full = pack.custom.length >= CUSTOM_CHECK_CAP;
  return (
    <span className="pills">
      {checks.length === 0 ? <span className="pill">No checks</span> : null}
      {checks.map((id) => (
        <span key={id} className="pill">
          <CheckName id={id} draft={draft} saved={saved} stats={stats} disabled={disabled} edit={edit} />
          <button type="button" aria-label={`Remove ${checkName(pack, id)}`} disabled={disabled} onClick={() => onChange(checks.filter((item) => item !== id))}>×</button>
        </span>
      ))}
      <Menu>
        <MenuTrigger asChild><button type="button" className="linkish" disabled={disabled}>Add check</button></MenuTrigger>
        <MenuContent align="start" style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)", overflowY: "auto" }}>
          {rest.map((id) => <MenuItem key={id} onSelect={() => onChange([...checks, id])}>{checkName(pack, id)}</MenuItem>)}
          {rest.length ? <MenuSeparator /> : null}
          <MenuItem disabled={full} onSelect={onNewCheck}>{full ? `New check (${CUSTOM_CHECK_CAP} at most)` : "New check…"}</MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}
