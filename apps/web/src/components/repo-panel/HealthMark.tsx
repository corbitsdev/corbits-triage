import type { ReactNode } from "react";
import type { RepoHealth } from "../../lib/repo-rows.ts";

const MARKS: Record<RepoHealth["tone"], ReactNode> = {
  ok: <span className="dot ready" />,
  warn: <span className="mk flag">!</span>,
  idle: <span className="dot hollow" />,
};

export default function HealthMark({ health }: { health: RepoHealth }) {
  return <span className={`hl ${health.tone}`}>{MARKS[health.tone]}{health.label}</span>;
}
