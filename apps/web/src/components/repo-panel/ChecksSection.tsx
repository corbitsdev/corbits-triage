import { useEffect, useState, type ReactNode } from "react";
import { Button, Switch } from "@corbits/react-ui";
import { applyRecommended, CATALOG_IDS, CUSTOM_CHECK_CAP, RECOMMENDED_ISSUE, type CatalogCheck, type CatalogId, type CheckPack, type IssueTracker, type TriageStats } from "@corbits/triage-contracts";
import { checkFormOfKind, customCheckOf, nextCustomId } from "../../lib/action-builder.ts";
import { catalogValue, checkOn, setCatalogCheck, upsertCustom, type DraftProblem, type RepoDraft } from "../../lib/pack-draft.ts";
import { evaluationOf, type CheckKind } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import CheckKindPicker from "./CheckKindPicker.tsx";
import CountField from "./CountField.tsx";
import CustomSentence from "./CustomSentence.tsx";
import EvalBadge from "./EvalBadge.tsx";
import TokenList from "./TokenList.tsx";

const TRACKERS: Array<{ value: IssueTracker; label: string }> = [
  { value: "either", label: "GitHub or Linear" },
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
];

/** Each check in words, in the order the panel lists them. */
const SENTENCES: Record<CatalogId, string> = {
  "max-files-changed": "Flag pull requests over the files limit",
  "max-lines-changed": "Flag pull requests over the lines limit",
  "linked-issue": "Require a linked issue",
  "no-merge-conflicts": "Flag merge conflicts with the base branch",
  "ci-green": "CI must pass before merge",
  "no-forbidden-paths": "Never accept changes to forbidden paths",
  focused: "Check the change is focused on one thing",
  docs: "Check docs are updated when behavior changes",
};

type ChecksSectionProps = { draft: RepoDraft; saved: CheckPack; stats: TriageStats | undefined; disabled: boolean; edit: RepoPack["edit"]; problem: DraftProblem | null };

/** Every rule, built in or the repository's own, as one sentence with its values inline, switched on or off for the verdict. */
export default function ChecksSection({ draft, saved, stats, disabled, edit, problem }: ChecksSectionProps) {
  const pack = draft.pack;
  const on = [...CATALOG_IDS, ...pack.custom.map((row) => row.id)].filter((id) => checkOn(pack, id)).length;
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const where = problem?.where;
  const reason = where?.section === "pack" || (where?.section === "custom" && where.id === undefined) ? problem?.reason : undefined;

  // A new check lands in the list with its first value ready to type.
  useEffect(function focusAdded() {
    if (added === null) return;
    const row = document.getElementById(`rp-custom-${added}`);
    (row?.querySelector<HTMLElement>("input:not(.name), select, .tokens button") ?? row?.querySelector<HTMLElement>("input.name"))?.focus();
    setAdded(null);
  }, [added]);

  function add(kind: CheckKind) {
    const form = checkFormOfKind(kind);
    const id = nextCustomId(pack, form.name);
    edit((current) => upsertCustom(current, customCheckOf(form, id)));
    setPicking(false);
    setAdded(id);
  }

  function set(id: CatalogId, row: Partial<CatalogCheck>) {
    edit((current) => setCatalogCheck(current, saved, id, row));
  }

  function count(id: CatalogId, key: "maxFiles" | "maxLines", label: string, min: number) {
    return <CountField value={catalogValue(pack, id, key)} label={label} min={min} disabled={disabled} onChange={(value) => set(id, { [key]: value })} />;
  }

  function toggle(id: CatalogId, enabled: boolean) {
    set(id, id === "linked-issue" && enabled && pack.checks["linked-issue"]?.tracker === "off" ? { enabled, tracker: RECOMMENDED_ISSUE.tracker } : { enabled });
  }

  const storedTracker = catalogValue(pack, "linked-issue", "tracker");
  const tracker = storedTracker === undefined || storedTracker === "off" ? RECOMMENDED_ISSUE.tracker : storedTracker;

  /** The sentence with its values inline; the others read as they are. */
  function words(id: CatalogId): ReactNode {
    switch (id) {
      case "max-files-changed":
        return <>Flag pull requests over <span className="nw">{count(id, "maxFiles", "Most files", 1)} files changed</span></>;
      case "max-lines-changed":
        return <>Flag pull requests over <span className="nw">{count(id, "maxLines", "Most lines", 1)} lines changed</span></>;
      case "linked-issue":
        return (
          <>Require a linked issue from
            <select className="val" aria-label="Issue tracker" disabled={disabled} value={tracker} onChange={(event) => set(id, { tracker: event.target.value as IssueTracker })}>
              {TRACKERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </>
        );
      case "no-forbidden-paths":
        return <>Never accept changes to <TokenList values={catalogValue(pack, id, "forbiddenGlobs") ?? []} noun="path" placeholder="path/**" mono disabled={disabled} onChange={(forbiddenGlobs) => set(id, { forbiddenGlobs })} /></>;
      default:
        return SENTENCES[id];
    }
  }

  function passed(id: string): string | null {
    const ran = stats?.checks[id];
    const runs = ran ? ran.pass + ran.fail + ran.unconfirmed : 0;
    return ran && runs > 0 ? `Passed ${ran.pass} of ${runs} this week` : null;
  }

  function sentence(id: CatalogId) {
    const stat = passed(id);
    return (
      <div key={id} className="sentence">
        <span className="txt">{words(id)}{stat ? <small>{stat}</small> : null}</span>
        {evaluationOf(pack, id) === "model" ? <EvalBadge evaluation="model" /> : null}
        <Switch className="sw" checked={checkOn(pack, id)} onCheckedChange={(next) => toggle(id, next)} label={SENTENCES[id]} disabled={disabled} />
      </div>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-checks" id="rp-checks">
      <h3 id="rs-checks">Rules <span className="n">{on} on</span></h3>
      <p>The rules Triage applies to every pull request. <button type="button" className="linkish" disabled={disabled} onClick={() => edit((current) => ({ ...current, pack: applyRecommended(current.pack) }))}>Reset to recommended</button></p>
      {reason ? <p className="reason">{reason}</p> : null}
      <div className="sentences">
        {(Object.keys(SENTENCES) as CatalogId[]).map(sentence)}
        {pack.custom.map((check) => (
          <CustomSentence key={check.id} check={check} draft={draft} disabled={disabled} edit={edit} stat={passed(check.id)} reason={where?.section === "custom" && where.id === check.id ? problem?.reason : undefined} />
        ))}
      </div>
      {picking ? <CheckKindPicker disabled={disabled} onPick={add} onCancel={() => setPicking(false)} /> : (
        <div className="more">
          {pack.custom.length >= CUSTOM_CHECK_CAP
            ? <p className="hint">Up to {CUSTOM_CHECK_CAP} rules of your own. Remove one to add another.</p>
            : <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setPicking(true)}>Add a rule</Button>}
        </div>
      )}
    </section>
  );
}
