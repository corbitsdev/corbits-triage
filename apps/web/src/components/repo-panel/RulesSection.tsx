import { useEffect, useState, type ReactNode } from "react";
import { Checkbox } from "@corbits/react-ui";
import { CATALOG_IDS, CUSTOM_CHECK_CAP, RECOMMENDED_ISSUE, type CatalogCheck, type CatalogId, type CheckPack, type IssueTracker, type TriageStats } from "@corbits/triage-contracts";
import { catalogValue, checkOn, removeCustom, setCatalogCheck, setCustomEnabled, type DraftProblem, type RepoDraft } from "../../lib/pack-draft.ts";
import type { JudgementRule } from "../../lib/policy-view.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import type { JudgementRow, PolicyView } from "../../lib/use-policy-view.ts";
import CountField from "./CountField.tsx";
import RuleRow from "./RuleRow.tsx";
import TokenList from "./TokenList.tsx";

const TRACKERS: Array<{ value: IssueTracker; label: string }> = [
  { value: "either", label: "GitHub or Linear" },
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
];

const HARD = "A failed rule here fails the pull request without asking the decision model.";

/** Help per rule, and its sentence while off. */
const CATALOG: Record<CatalogId, { off: string; tip: string }> = {
  "max-files-changed": { off: "Flag pull requests over a files limit", tip: `Counts the files the pull request changes; over the limit fails. ${HARD}` },
  "max-lines-changed": { off: "Flag pull requests over a lines limit", tip: `Counts added and removed lines; over the limit fails. ${HARD}` },
  "linked-issue": { off: "Require a linked issue", tip: `Looks for an issue reference in the title, body, commits or branch; none fails. ${HARD}` },
  "no-merge-conflicts": { off: "No merge conflicts with the base branch", tip: `Fails when GitHub reports a conflict with the base branch. ${HARD}` },
  "ci-green": { off: "CI must pass", tip: `Fails when a CI check fails; unconfirmed while checks still run. ${HARD}` },
  "no-forbidden-paths": { off: "Never accept changes to forbidden paths", tip: `Any changed file under these paths fails. ${HARD}` },
  focused: { off: "The change is focused on one thing", tip: "The decision model reads the diff and asks whether it does one thing. A mix fails the rule and names the files to split out." },
  docs: { off: "Docs are updated when behavior changes", tip: "For each changed file the decision model asks whether the docs are now wrong or missing something. Any yes fails the rule. Changing a doc passes it." },
};

const IS_TRUE_TIP = "A yes or no question the decision model answers from the pull request. No fails the rule.";

type Group = { name: string; sub: string; ids: CatalogId[]; cap?: string; note?: string; judgement?: boolean };

const GROUPS: Group[] = [
  { name: "Size", sub: "Flag large pull requests", ids: ["max-files-changed", "max-lines-changed"] },
  {
    name: "Checks",
    sub: "Facts GitHub already knows: issue, conflicts, CI, paths",
    ids: ["linked-issue", "no-merge-conflicts", "ci-green", "no-forbidden-paths"],
    note: "Always on: drafts wait until they are ready for review, and a pull request with changes requested fails.",
  },
  {
    name: "Judgement",
    sub: "Questions the decision model answers from the diff and docs",
    cap: "Optional. Rules without the decision model decide most pull requests on their own.",
    ids: ["focused", "docs"],
    judgement: true,
  },
];

/** The two rules every pull request runs outside the policy's switches. */
const ALWAYS_ON = 2;

type ScoreRule = Extract<JudgementRule, { shape: "score" }>;

function scoreTip(rule: ScoreRule): string {
  const fails = rule.failBelow ? ` Fails below ${rule.failBelow}.` : " Never fails a pull request.";
  return `The decision model picks a level from ${rule.levels[0]} to ${rule.levels.at(-1)}.${fails}`;
}

type RulesSectionProps = {
  draft: RepoDraft;
  saved: CheckPack;
  view: PolicyView;
  stats: TriageStats | undefined;
  disabled: boolean;
  edit: RepoPack["edit"];
  problem: DraftProblem | null;
};

/** Every rule as a sentence and a switch, in Size, Checks and Judgement cards. */
export default function RulesSection({ draft, saved, view, stats, disabled, edit, problem }: RulesSectionProps) {
  const pack = draft.pack;
  const on = [...CATALOG_IDS, ...pack.custom.map((row) => row.id)].filter((id) => checkOn(pack, id)).length + ALWAYS_ON;
  const [added, setAdded] = useState<string | null>(null);
  const where = problem?.where;
  const reason = where?.section === "pack" || (where?.section === "custom" && where.id === undefined) ? problem?.reason : undefined;

  // A new rule lands with its text ready to type.
  useEffect(function focusAdded() {
    if (added === null) return;
    document.querySelector<HTMLElement>(`#rp-rule-${CSS.escape(added)} input`)?.focus();
    setAdded(null);
  }, [added]);

  function set(id: CatalogId, row: Partial<CatalogCheck>) {
    edit((current) => setCatalogCheck(current, saved, id, row));
  }

  function toggle(id: CatalogId, enabled: boolean) {
    set(id, id === "linked-issue" && enabled && pack.checks["linked-issue"]?.tracker === "off" ? { enabled, tracker: RECOMMENDED_ISSUE.tracker } : { enabled });
  }

  function passed(id: string): string | null {
    const ran = stats?.checks[id];
    const runs = ran ? ran.pass + ran.fail + ran.unconfirmed : 0;
    return ran && runs > 0 ? `${ran.pass} of ${runs} passed` : null;
  }

  function count(id: CatalogId, key: "maxFiles" | "maxLines", label: string) {
    return <CountField value={catalogValue(pack, id, key)} label={label} min={1} disabled={disabled} onChange={(value) => set(id, { [key]: value })} />;
  }

  const storedTracker = catalogValue(pack, "linked-issue", "tracker");
  const tracker = storedTracker === undefined || storedTracker === "off" ? RECOMMENDED_ISSUE.tracker : storedTracker;

  function words(id: CatalogId): ReactNode {
    switch (id) {
      case "max-files-changed":
        return <>Flag pull requests over {count(id, "maxFiles", "Most files")} files changed</>;
      case "max-lines-changed":
        return <>Flag pull requests over {count(id, "maxLines", "Most lines")} lines changed</>;
      case "linked-issue":
        return (
          <>Require a linked issue from{" "}
            <select className="val" aria-label="Issue tracker" disabled={disabled} value={tracker} onChange={(event) => set(id, { tracker: event.target.value as IssueTracker })}>
              {TRACKERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </>
        );
      case "no-forbidden-paths":
        return <>Never accept changes to <TokenList values={catalogValue(pack, id, "forbiddenGlobs") ?? []} noun="path" placeholder="path/**" mono disabled={disabled} onChange={(forbiddenGlobs) => set(id, { forbiddenGlobs })} /></>;
      default:
        return CATALOG[id].off;
    }
  }

  function catalogRow(id: CatalogId) {
    const ruleOn = checkOn(pack, id);
    return (
      <RuleRow
        key={id}
        id={id}
        label={CATALOG[id].off}
        on={ruleOn}
        words={ruleOn ? words(id) : CATALOG[id].off}
        tip={CATALOG[id].tip}
        model={id === "focused" || id === "docs"}
        stat={passed(id)}
        disabled={disabled}
        onToggle={(next) => toggle(id, next)}
      />
    );
  }

  function failBelow(rule: ScoreRule) {
    const first = rule.levels[1]!;
    return (
      <div className="levels">
        <Checkbox checked={rule.failBelow !== undefined} label="fail below" disabled={disabled} onCheckedChange={(checked) => view.patchRule(rule.id, { failBelow: checked ? first : null })} />
        <select className="val q" aria-label="Fail below" disabled={disabled || rule.failBelow === undefined} value={rule.failBelow ?? first} onChange={(event) => view.patchRule(rule.id, { failBelow: event.target.value })}>
          {rule.levels.slice(1).map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </div>
    );
  }

  function judgementRow(rule: JudgementRow) {
    const text = rule.shape === "is-true" ? rule.claim : rule.subject;
    const label = rule.shape === "is-true" ? `Is it true that ${text || "…"}?` : `Score ${text || "…"}`;
    const words = rule.shape === "is-true"
      ? <>Is it true that <input className="val w" aria-label="Claim" placeholder="the title says what changed" disabled={disabled} value={rule.claim} onChange={(event) => view.patchRule(rule.id, { claim: event.target.value })} />?</>
      : <>Score <input className="val w" aria-label="What to score" placeholder="how well the change follows CONTRIBUTING.md" disabled={disabled} value={rule.subject} onChange={(event) => view.patchRule(rule.id, { subject: event.target.value })} /></>;
    return (
      <RuleRow
        key={rule.id}
        id={rule.id}
        label={label}
        on={rule.on}
        words={rule.on ? words : label}
        tip={rule.shape === "is-true" ? IS_TRUE_TIP : scoreTip(rule)}
        model
        stat={passed(rule.id)}
        more={rule.shape === "score" ? failBelow(rule) : null}
        reason={rule.problem}
        disabled={disabled}
        onToggle={(next) => edit((current) => setCustomEnabled(current, rule.id, next))}
        onRemove={() => edit((current) => removeCustom(current, rule.id))}
      />
    );
  }

  function add(shape: JudgementRule["shape"]) {
    setAdded(view.addRule(shape));
  }

  function addRow() {
    if (pack.custom.length >= CUSTOM_CHECK_CAP) return <p className="group-note">Up to {CUSTOM_CHECK_CAP} rules of your own. Remove one to add another.</p>;
    return (
      <div className="sentence add-row">
        <button type="button" className="linkish quiet" disabled={disabled} onClick={() => add("is-true")}>+ Is it true that …</button>
        <button type="button" className="linkish quiet" disabled={disabled} onClick={() => add("score")}>+ Score …</button>
      </div>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-rules" id="rp-rules">
      <h3 id="rs-rules">Rules <span className="n">{on} on</span></h3>
      {reason ? <p className="reason">{reason}</p> : null}
      {GROUPS.map((group) => (
        <section key={group.name} className="gcard" aria-label={group.name}>
          <header><b>{group.name}</b><span>{group.sub}</span>{group.cap ? <em>{group.cap}</em> : null}</header>
          <div className="sentences">
            {group.ids.map(catalogRow)}
            {group.judgement ? view.rules.map(judgementRow) : null}
            {group.judgement ? addRow() : null}
          </div>
          {group.note ? <p className="group-note">{group.note}</p> : null}
        </section>
      ))}
    </section>
  );
}
