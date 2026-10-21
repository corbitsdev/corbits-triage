import { CATALOG_IDS, catalogCheckEnabled, catalogSentence, customCheckEnabled, customSentence, hostKinds, onFailText, people, VERDICT_NAMES, VERDICTS, type CatalogId, type CheckPack, type CustomCheck, type RepoSource, type Step, type VerdictWord } from "@corbits/triage-contracts";
import { FOR_NAMES, forChoice, stepFor } from "../../lib/policy-view.ts";

function doText(step: Step): string {
  switch (step.do) {
    case "labels":
      return step.target.from === "rules" ? "Label each failed rule" : `Add labels ${step.target.labels.join(", ")}`;
    case "assign":
      return `Assign to ${people(step.target)}`;
    case "request-review":
      return `Request review from ${people(step.target)}`;
    case "comment":
      return `Comment “${step.target.body}”`;
    case "request-changes":
      return "Request changes";
    case "nothing":
      return "Do nothing";
    default:
      return step.do.charAt(0).toUpperCase() + step.do.slice(1);
  }
}

/** Whom a step is for, after its action; anyone goes unsaid. */
function forText(step: Step): string {
  const choice = forChoice(step);
  const match = stepFor(step);
  if (choice === "anyone") return "";
  if (typeof match === "object" && "group" in match) return `, for ${match.group}`;
  if (typeof match === "object" && "team" in match) return `, for @${match.team}`;
  if (typeof match === "object") return `, for ${match.users.map((user) => `@${user}`).join(", ")}`;
  return `, for ${FOR_NAMES[choice]}`;
}

/** A built-in rule's sentence when it does something: CI written off still changes merging, a linked issue from nowhere does nothing. */
function catalogText(pack: CheckPack, id: CatalogId): string | null {
  if (id === "ci-green" && pack.checks[id]?.enabled === false) return "Merges need not wait for CI";
  if (!catalogCheckEnabled(pack, id) || (id === "linked-issue" && pack.checks[id]?.tracker === "off")) return null;
  return catalogSentence(id, pack);
}

function customText(row: CustomCheck): string {
  return row.kind === "model" && row.shape === "is-true" ? row.claim : customSentence(row);
}

/** The verdict Triage posts before any step: its comment, with the verdict's label, or on a host without labels its build status. */
function postText(pack: CheckPack, source: RepoSource, verdict: VerdictWord): string {
  return hostKinds(source).includes("labels") ? `Comment, and label “${pack.labels[verdict]}”` : "Comment, and set the build status";
}

/** The policy triage runs on, read only: each rule that is on, then what happens on each verdict. */
export default function PolicyRules({ pack, source }: { pack: CheckPack; source: RepoSource }) {
  const rules = [
    ...CATALOG_IDS.flatMap(function shown(id) {
      const text = catalogText(pack, id);
      return text ? [{ key: id, text }] : [];
    }),
    ...pack.custom.filter(customCheckEnabled).map((row) => ({ key: row.id, text: customText(row) })),
  ].map(function withOnFail(rule) {
    const onFail = onFailText(pack, rule.key);
    return onFail === undefined ? rule : { ...rule, text: `${rule.text} (${onFail})` };
  });

  return (
    <div className="gcard">
      <div className="sentences">
        {rules.length === 0 ? <div className="sentence"><span className="txt">No rules are on.</span></div> : null}
        {rules.map((rule) => <div key={rule.key} className="sentence"><span className="txt">{rule.text}</span></div>)}
      </div>
      <div className="then-t">
        {VERDICTS.map((verdict) => (
          <div key={verdict} className="then">
            <b>{VERDICT_NAMES[verdict]}</b>
            <div className="steps">
              <span>{postText(pack, source, verdict)}</span>
              {pack.actions[verdict].map((step, at) => <span key={`${verdict}-${at}`}>{doText(step)}{forText(step)}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
