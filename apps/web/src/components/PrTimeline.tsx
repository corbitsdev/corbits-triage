import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CheckPack } from "@corbits/triage-contracts";
import { checkPackQuery } from "../lib/check-packs.ts";
import { relativeTime } from "../lib/duration.ts";
import { errorText } from "../lib/error-text.ts";
import type { CheckChange, DoRun, PrItem, TimelineEntry } from "../lib/hub-api.ts";
import { DO_NAMES, DONE_DO_NAMES, checkName } from "../lib/pack-prose.ts";
import { usePortal } from "../lib/portal.tsx";
import { usePrTimeline } from "../lib/pr-timeline.ts";

function doText({ kind, status }: DoRun): string {
  switch (status) {
    case "done": return DONE_DO_NAMES[kind];
    case "satisfied": return `${DO_NAMES[kind]}: already done`;
    case "running": return `${DO_NAMES[kind]}: running`;
    case "failed": return `${DO_NAMES[kind]}: failed`;
  }
}

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

function DoRow({ run }: { run: DoRun }) {
  return (
    <li className={`timeline-entry timeline-do${run.status === "failed" ? " failed" : ""}`}>
      <span className="timeline-score" aria-hidden="true" />
      <p>{doText(run)} <span className="muted">· {relativeTime(run.updatedAt)}</span></p>
    </li>
  );
}

export function PrTimeline({ item }: { item: PrItem }) {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const timeline = usePrTimeline(item.repo, item.number);
  const packArtifact = useQuery(checkPackQuery(queryClient, snapshot?.workspace.tenantId, item.repo)).data;
  const pack = packArtifact?.kind === "pack" ? packArtifact.pack : null;
  const { items } = timeline;
  const trend = items.flatMap((row) => (row.type === "verdict" && row.verdict.settled && row.verdict.readiness !== null ? [row.verdict.readiness] : []));
  return (
    <section className="brief pr-timeline">
      <h2>Readiness history</h2>
      {timeline.isPending ? <p className="muted">Loading history…</p>
        : timeline.error ? <p className="muted">Could not load history. {errorText(timeline.error)}</p>
        : items.length <= 1 ? <p className="muted">The history starts with the next triage.</p>
        : (
          <>
            {trend.length > 1 ? <p className="timeline-trend mono">{trend.join(" → ")}</p> : null}
            <ol className="timeline">
              {items.map((row) => (row.type === "verdict"
                ? <VerdictRow key={row.verdict.runId} verdict={row.verdict} pack={pack} />
                : <DoRow key={row.run.effectId} run={row.run} />))}
            </ol>
          </>
        )}
    </section>
  );
}
