import type { RepoSource, TriageOutcomes } from "@corbits/triage-contracts";
import { OUTCOME_NAMES, medianText, humansText, outcomeCounts, outcomesView, type OutcomeField, type OutcomesView } from "../../lib/repo-stats.ts";

const FIELDS = Object.keys(OUTCOME_NAMES) as OutcomeField[];

type MeasuredView = Exclude<OutcomesView, { missing: string }>;

function OutcomeRow({ field, view }: { field: OutcomeField; view: MeasuredView }) {
  return (
    <tr>
      <th scope="row">{OUTCOME_NAMES[field]}</th>
      <td>{medianText(view.triaged[field])}</td>
      <td>{view.baseline ? medianText(view.baseline[field]) : "–"}</td>
    </tr>
  );
}

function OutcomesTable({ view }: { view: MeasuredView }) {
  return (
    <div className="gcard">
      <p className="humans">{humansText(view.humans)}</p>
      <table className="outcomes">
        <thead>
          <tr>
            <th />
            <th scope="col">With Triage <span>{outcomeCounts(view.triaged)}</span></th>
            <th scope="col">Before Triage <span>{view.baseline ? outcomeCounts(view.baseline) : view.baselineMissing}</span></th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((field) => <OutcomeRow key={field} field={field} view={view} />)}
        </tbody>
      </table>
    </div>
  );
}

type OutcomesCardProps = { outcomes: TriageOutcomes | null; source: RepoSource };

/** What happened to the pull requests Triage saw, beside those closed before it. */
export default function OutcomesCard({ outcomes, source }: OutcomesCardProps) {
  const view = outcomesView(outcomes, source);
  if (view === null) return null;
  return (
    <section className="rs outcomes-card" aria-labelledby="rs-outcomes">
      <h3 id="rs-outcomes">Outcomes</h3>
      <p className="help">Medians from opening, over the newest triaged pull requests and those closed before Triage.</p>
      {"missing" in view ? <p className="note">{view.missing}</p> : <OutcomesTable view={view} />}
    </section>
  );
}
