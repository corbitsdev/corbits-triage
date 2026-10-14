import type { RepoRow } from "../../lib/repo-rows.ts";
import { relativeTime } from "../../lib/triage-view.ts";
import HealthMark from "./HealthMark.tsx";

export default function RepoByline({ row }: { row: RepoRow }) {
  if ("error" in row.pulls) return <div className="byline"><span title={row.pulls.error}>Could not read pull requests from GitHub</span></div>;
  const { open, needsYou, lastActivity } = row.pulls;
  return (
    <div className="byline">
      <span>{open} open</span>
      <span>{needsYou} need you</span>
      <span>{lastActivity ? `last activity ${relativeTime(lastActivity)}` : "no activity yet"}</span>
      <span><HealthMark health={row.health} /></span>
    </div>
  );
}
