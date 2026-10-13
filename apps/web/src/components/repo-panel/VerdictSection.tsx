import { CATALOG_IDS, checkName, NO_CHANGES_REQUESTED, type CheckRef } from "@corbits/triage-contracts";
import { checkOn, type RepoDraft } from "../../lib/pack-draft.ts";
import { evaluationOf, listed } from "../../lib/pack-prose.ts";

/** How sure, in percent, the decision model must be for a verdict to pass or fail. */
const DECIDES_AT = 70;

/** How each pull request is decided; read only, since only the rules above change it. */
export default function VerdictSection({ draft }: { draft: RepoDraft }) {
  const pack = draft.pack;
  // Requested changes always run.
  const hard = [...CATALOG_IDS, ...pack.custom.map((row) => row.id as CheckRef)]
    .filter((id) => checkOn(pack, id) && evaluationOf(pack, id) === "rule")
    .map((id) => checkName(pack, id))
    .concat(checkName(pack, NO_CHANGES_REQUESTED));
  const modelled = [...CATALOG_IDS, ...pack.custom.map((row) => row.id as CheckRef)].some((id) => checkOn(pack, id) && evaluationOf(pack, id) === "model");
  return (
    <section className="rs" aria-labelledby="rs-verdict" id="rp-verdict">
      <h3 id="rs-verdict">Verdict</h3>
      <p>Drafts and closed pull requests are not decided.</p>
      <div className="sentences">
        <div className="sentence"><span className="txt"><b>Fail</b> {hard.length ? <>as soon as {listed(hard, "or")} fails, without asking the decision model</> : "when a rule that needs no model fails"}</span></div>
        {modelled ? (
          <>
            <div className="sentence"><span className="txt"><b>Pass</b> when the decision model is at least {DECIDES_AT}% sure the pull request passes this repository's policy</span></div>
            <div className="sentence"><span className="txt"><b>Fail</b> when it is at least {DECIDES_AT}% sure it does not</span></div>
          </>
        ) : (
          <div className="sentence"><span className="txt"><b>Pass</b> when every rule passes, without asking the decision model</span></div>
        )}
        <div className="sentence"><span className="txt"><b>Unsure</b> otherwise</span></div>
      </div>
    </section>
  );
}
