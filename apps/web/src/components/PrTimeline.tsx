import { checkName, type CheckPack } from "@corbits/triage-contracts";
import { useRepoPack } from "../lib/check-packs.ts";
import { relativeTime } from "../lib/duration.ts";
import { errorText } from "@corbits/common";
import type { CheckChange, PrItem, TimelineEntry } from "../lib/hub-api.ts";
import { usePrTimeline } from "../lib/pr-timeline.ts";

function changeText(pack: CheckPack | null, { check, from, to }: CheckChange): string {
  const name = pack ? checkName(pack, check) : check;
  if (from === null) return `${name} added (${to})`;
  if (to === null) return `${name} removed`;
  return `${name} ${from} → ${to}`;
}

function VerdictRow({ verdict, pack }: { verdict: TimelineEntry; pack: CheckPack | null }) {
  const { readiness } = verdict;
  return (
    <li className="timeline-entry">
      {readiness === null
        ? <span className="timeline-score mono" aria-label="no readiness">–</span>
        : <span className="timeline-score mono" aria-label={`readiness ${readiness} of 100`}>{readiness}%</span>}
      <div>
        <p>
          <span className="mono">{verdict.headSha.slice(0, 7)}</span> <span className="muted">· {relativeTime(verdict.at)}{verdict.settled ? "" : " · waiting"}</span>
        </p>
        {verdict.degraded === null ? null : <p className="muted">Triage degraded: {verdict.degraded}</p>}
        {verdict.changed.length === 0 ? null : <p className="soft">{verdict.changed.map((change) => changeText(pack, change)).join(", ")}</p>}
      </div>
    </li>
  );
}

export function PrTimeline({ item }: { item: PrItem }) {
  const timeline = usePrTimeline(item.repo, item.number, item.source);
  const pack = useRepoPack(item.repo, item.source);
  const entries = timeline.data?.entries ?? [];
  const trend = entries.flatMap((verdict) => (verdict.settled && verdict.readiness !== null ? [verdict.readiness] : []));

  function renderEntries() {
    if (timeline.isPending) return <p className="muted">Loading history…</p>;
    if (timeline.error) return <p className="muted">Could not load history. {errorText(timeline.error)}</p>;
    if (entries.length <= 1) return <p className="muted">The history starts with the next triage.</p>;
    return (
      <>
        {trend.length > 1 ? <p className="timeline-trend mono">{trend.join(" → ")}</p> : null}
        <ol className="timeline">
          {entries.map((verdict) => <VerdictRow key={verdict.runId} verdict={verdict} pack={pack} />)}
        </ol>
      </>
    );
  }

  return (
    <section className="brief pr-timeline">
      <h2>Readiness history</h2>
      {renderEntries()}
    </section>
  );
}
