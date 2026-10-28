import type { Transport } from "@intx/hub-client";
import type { TriageStats } from "@corbits/triage-contracts";

export type FakeHub = {
  transport: Transport;
  stats: TriageStats | null;
  requests: string[];
};

/** The stats route as the hub serves it, answering `stats` once it is set; each request is kept in order. */
export function fakeHub(): FakeHub {
  const hub: FakeHub = { stats: null, requests: [], transport: { fetch, subscribe: () => () => {} } };
  async function fetch<T>(method: string, path: string): Promise<T> {
    hub.requests.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/api/integrations/triage-stats/t?") && hub.stats) return hub.stats as T;
    throw new Error(`unexpected ${method} ${path}`);
  }
  return hub;
}
