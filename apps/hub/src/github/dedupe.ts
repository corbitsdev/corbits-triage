// Persistent delivery-id cache for the legacy GitHub bridge. GitHub may
// redeliver a webhook after a hub restart, so seen ids are journaled to a
// bounded disk JSON file (array of [id, firstSeenMs] pairs) and reloaded on
// boot. Entries expire after ttlMs (redeliveries arrive within hours; a stale
// id must become retryable) and the journal is capped at max entries, oldest
// first. Persistence is best-effort: disk errors never fail delivery handling
// — the in-memory map stays authoritative within the process.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DeliveryCacheOptions {
  max?: number;
  ttlMs?: number;
  /** Omitted keeps the cache in memory only. */
  filePath?: string;
  now?: () => number;
}

const DEFAULT_MAX = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class DeliveryCache {
  private seen = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly filePath: string | undefined;
  private readonly now: () => number;

  constructor(opts: DeliveryCacheOptions = {}) {
    this.max = opts.max ?? DEFAULT_MAX;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.filePath = opts.filePath;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** True if id was already seen; otherwise records it. */
  check(id: string): boolean {
    const now = this.now();
    this.prune(now);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.save();
    return false;
  }

  forget(id: string): void {
    if (this.seen.delete(id)) this.save();
  }

  private prune(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(id);
    }
  }

  private load(): void {
    if (this.filePath === undefined) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // missing journal: cold start
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt journal: start empty rather than crash boot
    }
    if (!Array.isArray(parsed)) return;
    const now = this.now();
    const fresh: Array<[string, number]> = [];
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number") continue;
      if (now - entry[1] > this.ttlMs) continue;
      fresh.push([entry[0], entry[1]]);
    }
    // Journal order is oldest-first: keep the newest `max`.
    for (const [id, at] of fresh.slice(-this.max)) this.seen.set(id, at);
  }

  private save(): void {
    if (this.filePath === undefined) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.seen]), "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      // best-effort: memory stays authoritative for this process
    }
  }
}
