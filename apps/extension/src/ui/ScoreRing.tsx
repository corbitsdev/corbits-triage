const RADIUS = 23;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ScoreRing({ value }: { value: number | null }) {
  const filled = value === null ? 0 : (CIRCUMFERENCE * value) / 100;
  return (
    <svg className="score-ring" viewBox="0 0 56 56" role="img" aria-label={value === null ? "No readiness score" : `Readiness ${value} of 100`}>
      <circle cx="28" cy="28" r={RADIUS} fill="none" stroke="var(--ring-track)" strokeWidth="5" />
      <circle cx="28" cy="28" r={RADIUS} fill="none" stroke="var(--foreground)" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${filled} ${CIRCUMFERENCE}`} transform="rotate(-90 28 28)" />
      <text x="28" y="33" textAnchor="middle">{value ?? "–"}</text>
    </svg>
  );
}
