import { useLayoutEffect, useRef, useState } from "react";
import { Switch } from "@corbits/react-ui";
import { catalogCheckEnabled, type CatalogCheck, type CatalogId, type CheckPack, type CheckRef, type CustomCheck, type IssueTracker } from "@corbits/triage-contracts";
import { buildCustomCheck, checkFormOf } from "../../lib/action-builder.ts";
import type { TriageStats } from "../../lib/hub-api.ts";
import { CATALOG_DEFAULTS, removeCustom, setCatalogCheck, upsertCustom, type RepoDraft } from "../../lib/pack-draft.ts";
import { checkName, evaluationOf, isCatalogId, shownReason } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import CheckFields from "./CheckFields.tsx";
import EvalBadge from "./EvalBadge.tsx";
import TokenList from "./TokenList.tsx";

const TRACKERS: Array<{ value: IssueTracker; label: string }> = [
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
  { value: "either", label: "GitHub or Linear" },
  { value: "off", label: "Not required" },
];

const METHOD = { rule: "Computed from GitHub.", model: "Answered from the diff, citing files and lines." };

export type CheckPopoverProps = { id: CheckRef; draft: RepoDraft; saved: CheckPack; stats: TriageStats | undefined; disabled: boolean; edit: RepoPack["edit"]; onClose: () => void };

function catalogValue<K extends keyof CatalogCheck>(pack: CheckPack, id: CatalogId, key: K): CatalogCheck[K] {
  return pack.checks[id]?.[key] ?? CATALOG_DEFAULTS[id]?.[key] as CatalogCheck[K];
}

type CatalogProps = { id: CatalogId; pack: CheckPack; saved: CheckPack; disabled: boolean; edit: RepoPack["edit"] };

function CatalogParams({ id, pack, saved, disabled, edit }: CatalogProps) {
  function set(row: Partial<CatalogCheck>) {
    edit((current) => setCatalogCheck(current, saved, id, row));
  }

  function count(key: "maxFiles" | "maxLines" | "maxBehindBy", label: string, min: number) {
    return <input className="val" type="number" min={min} step={1} aria-label={label} disabled={disabled} value={catalogValue(pack, id, key) ?? 0} onChange={(event) => set({ [key]: Number(event.target.value) })} />;
  }

  const on = catalogCheckEnabled(pack, id);
  return (
    <>
      <div className="sentence">
        <span className="txt">In the verdict</span>
        <Switch className="sw" checked={on} onCheckedChange={(enabled) => set({ enabled })} label={`${checkName(pack, id)} in the verdict`} disabled={disabled} />
      </div>
      {id === "size" ? <p className="txt">Flag more than {count("maxFiles", "Most files", 1)} files or {count("maxLines", "Most lines", 1)} lines</p> : null}
      {id === "drift" ? <p className="txt">Flag {count("maxBehindBy", "Commits behind", 0)} or more commits behind the base branch</p> : null}
      {id === "paths" ? <p className="txt">Never accept changes to <TokenList values={catalogValue(pack, id, "forbiddenGlobs") ?? []} noun="path" placeholder="path/**" mono disabled={disabled} onChange={(forbiddenGlobs) => set({ forbiddenGlobs })} /></p> : null}
      {id === "issue" ? (
        <>
          <p className="txt">Require a linked issue in
            <select className="val" aria-label="Issue tracker" disabled={disabled} value={catalogValue(pack, id, "tracker") ?? "either"} onChange={(event) => set({ tracker: event.target.value as IssueTracker })}>
              {TRACKERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </p>
          <div className="sentence">
            <span className="txt">Require the label <input className="val w" aria-label="Issue label" disabled={disabled || !on} value={catalogValue(pack, id, "label") ?? ""} onChange={(event) => set({ label: event.target.value })} /></span>
            <Switch className="sw" checked={on && pack.checks.issue?.requireLabel === true} onCheckedChange={(requireLabel) => set({ requireLabel })} label="Require a label on the linked issue" disabled={disabled || !on} />
          </div>
        </>
      ) : null}
    </>
  );
}

type CustomProps = { check: CustomCheck; draft: RepoDraft; disabled: boolean; edit: RepoPack["edit"]; onClose: () => void };

function CustomParams({ check, draft, disabled, edit, onClose }: CustomProps) {
  const [form, setForm] = useState(() => checkFormOf(check));
  const [refused, setRefused] = useState("");
  const built = buildCustomCheck(form, draft.pack, check.id);

  function save() {
    if ("reason" in built) return;
    edit((current) => upsertCustom(current, built));
    onClose();
  }

  function remove() {
    const next = removeCustom(draft, check.id);
    if ("reason" in next) {
      setRefused(shownReason(next.reason, draft.pack));
      return;
    }
    edit(() => next);
    onClose();
  }

  return (
    <>
      <CheckFields form={form} disabled={disabled} onChange={setForm} />
      {"reason" in built ? <p className="reason">{shownReason(built.reason, draft.pack)}</p> : null}
      {refused ? <p role="alert" className="reason">{refused}</p> : null}
      <div className="pfoot">
        <button type="button" className="linkish" disabled={disabled} onClick={remove}>Remove check</button>
        <button type="button" className="btn btn-sm" disabled={disabled || "reason" in built} onClick={save}>Save check</button>
      </div>
    </>
  );
}

/** How a check is evaluated and its parameters; catalog edits apply as they are made, custom ones on Save. */
export default function CheckPopover({ id, draft, saved, stats, disabled, edit, onClose }: CheckPopoverProps) {
  const pack = draft.pack;
  const ref = useRef<HTMLDivElement>(null);

  // Anchored to a name inside wrapped prose, so it shifts left when it would run past the panel's edge.
  useLayoutEffect(function stayInPanel() {
    const pop = ref.current;
    const pane = pop?.closest(".pane-in");
    if (!pop || !pane) return;
    const edge = pane.getBoundingClientRect().right - parseFloat(getComputedStyle(pane).paddingRight);
    const over = pop.getBoundingClientRect().right - edge;
    if (over > 0) pop.style.left = `${-over}px`;
  }, []);

  const custom = isCatalogId(id) ? undefined : pack.custom.find((row) => row.id === id);
  const evaluation = evaluationOf(pack, id);
  const ran = stats?.checks[id];
  const runs = ran ? ran.pass + ran.fail + ran.unconfirmed : 0;
  return (
    <div className="pop check-pop" ref={ref} role="dialog" aria-label={checkName(pack, id)}>
      <div className="pop-h"><b>{checkName(pack, id)}</b><EvalBadge evaluation={evaluation} /></div>
      <p className="hint">{METHOD[evaluation]}</p>
      {ran && runs > 0 ? <p className="hint">Passed {ran.pass} of {runs} this week</p> : null}
      {isCatalogId(id) ? <CatalogParams id={id} pack={pack} saved={saved} disabled={disabled} edit={edit} /> : null}
      {custom ? <CustomParams check={custom} draft={draft} disabled={disabled} edit={edit} onClose={onClose} /> : null}
    </div>
  );
}
