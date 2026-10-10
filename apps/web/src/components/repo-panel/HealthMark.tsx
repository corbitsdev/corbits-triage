import type { RepoHealth } from "../../lib/repo-rows.ts";

export default function HealthMark({ health }: { health: RepoHealth }) {
  const mark = health.tone === "ok"
    ? <span className="dot ready" />
    : health.tone === "warn" ? <span className="mk flag">!</span> : <span className="dot hollow" />;
  return <span className={`hl ${health.tone}`}>{mark}{health.label}</span>;
}
