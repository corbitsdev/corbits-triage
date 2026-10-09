const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;
const MONTH = 2_592_000_000;
const YEAR = 31_104_000_000;

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms <= DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms <= 7 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms <= 4 * WEEK) return `${Math.floor(ms / WEEK)}w`;
  if (ms <= 12 * MONTH) return `${Math.max(1, Math.floor(ms / MONTH))}mo`;
  return `${Math.floor(ms / YEAR)}y`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "unknown time";
  const ms = Math.max(0, now - at);
  return `${formatDuration(ms)} ago`;
}

export function ageText(iso: string | null, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const ms = Math.max(0, now - at);
  return formatDuration(ms);
}
