import { StatGrid, StatGridItem } from "@corbits/react-ui";
import type { TriageStats } from "../../lib/hub-api.ts";

const MINUTE = 60_000;

function medianText(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(ms / MINUTE);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Recorded verdicts only reach back to the first one, which may fall inside the window that starts on the first day. */
function sinceText(stats: TriageStats): string | undefined {
  const start = stats.daily[0];
  if (stats.since === null || start === undefined || Date.parse(stats.since) <= Date.parse(start.date)) return undefined;
  return `since ${new Date(stats.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** The repository's recent triage; nothing until the stats arrive. Two tiles a row, since the grid's breakpoints follow the viewport and the panel is too narrow for four. */
export default function TriageStrip({ stats }: { stats: TriageStats | undefined }) {
  if (!stats) return null;
  const span = `the last ${plural(stats.days, "day")}`;
  if (stats.triaged === 0) return <p className="hint strip">No pull requests triaged in {span}.</p>;
  const daily = stats.daily.map((day) => day.triaged);
  const actedOn = Object.values(stats.actions).reduce((sum, action) => sum + action.executed, 0);
  return (
    <section className="strip" aria-label={`Triage in ${span}`}>
      <StatGrid columns={2}>
        <StatGridItem
          label="Triaged"
          value={String(stats.triaged)}
          sub={sinceText(stats)}
          sparklineValues={daily.filter((count) => count > 0).length >= 3 ? daily : undefined}
          sparklineLabel="Pull requests triaged each day"
        />
        <StatGridItem label="Needed you" value={String(stats.neededYou)} />
        <StatGridItem label="Acted on" value={String(actedOn)} sub={plural(stats.comments, "comment")} />
        <StatGridItem label="Median to verdict" value={medianText(stats.medianTimeToVerdictMs)} />
      </StatGrid>
    </section>
  );
}
