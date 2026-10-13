import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { ALL_CHECKS, CATALOG_IDS, CUSTOM_CHECK_CAP, type ActionCheckRef, type CheckRef } from "@corbits/triage-contracts";
import type { TriageStats } from "../../lib/hub-api.ts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { ALL_CHECKS_NAME, checkName } from "../../lib/pack-prose.ts";
import CheckName from "./CheckName.tsx";

type CheckPickerProps = {
  checks: ActionCheckRef[];
  draft: RepoDraft;
  stats: TriageStats | undefined;
  disabled: boolean;
  onChange: (checks: ActionCheckRef[]) => void;
  onNewCheck: () => void;
};

/** The checks whose combined verdict picks the branch: all of them, or ones chosen by name or created new. */
export default function CheckPicker({ checks, draft, stats, disabled, onChange, onNewCheck }: CheckPickerProps) {
  const pack = draft.pack;
  const all: CheckRef[] = ["draft", ...CATALOG_IDS, ...pack.custom.map((row) => row.id as CheckRef)];
  const every = checks.includes(ALL_CHECKS);
  const rest = every ? [] : all.filter((id) => !checks.includes(id));
  const full = pack.custom.length >= CUSTOM_CHECK_CAP;
  return (
    <span className="pills">
      {checks.length === 0 ? <span className="pill">No checks</span> : null}
      {checks.map((id) => (
        <span key={id} className="pill">
          {id === ALL_CHECKS ? ALL_CHECKS_NAME : <CheckName id={id} draft={draft} stats={stats} />}
          <button type="button" aria-label={`Remove ${id === ALL_CHECKS ? ALL_CHECKS_NAME : checkName(pack, id)}`} disabled={disabled} onClick={() => onChange(checks.filter((item) => item !== id))}>×</button>
        </span>
      ))}
      <Menu>
        <MenuTrigger asChild><button type="button" className="linkish" disabled={disabled}>Add check</button></MenuTrigger>
        <MenuContent align="start" style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)", overflowY: "auto" }}>
          {every ? null : <><MenuItem onSelect={() => onChange([ALL_CHECKS])}>All checks</MenuItem><MenuSeparator /></>}
          {rest.map((id) => <MenuItem key={id} onSelect={() => onChange([...checks, id])}>{checkName(pack, id)}</MenuItem>)}
          {rest.length ? <MenuSeparator /> : null}
          <MenuItem disabled={full} onSelect={onNewCheck}>{full ? `New check (${CUSTOM_CHECK_CAP} at most)` : "New check…"}</MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}
