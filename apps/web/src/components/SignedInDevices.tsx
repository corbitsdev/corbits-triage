import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";
import { listSessions, revokeSession, type HubSessionRow } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";

const SESSIONS_QUERY_KEY = "hub-sessions";

async function readSessions(): Promise<HubSessionRow[]> {
  return listSessions(createHubTransport());
}

export function SignedInDevices() {
  const query = useQuery({ queryKey: [SESSIONS_QUERY_KEY], queryFn: readSessions });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function revoke(session: HubSessionRow) {
    setPending(session.id);
    setError("");
    try {
      await revokeSession(createHubTransport(), session.id);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
      await query.refetch();
    }
  }

  if (query.error) return <p role="alert" className="field-error">{query.error.message}</p>;
  if (!query.data) return null;
  return (
    <div aria-label="Signed-in devices">
      <h3>Signed-in devices</h3>
      {query.data.map((session) => (
        <div key={session.id} className="row">
          <span>{session.isCurrent ? "This browser" : session.userAgent ?? "Unknown device"} · since {new Date(session.createdAt).toLocaleString()}</span>
          {!session.isCurrent && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void revoke(session)}>Sign out</Button>}
        </div>
      ))}
      {error && <p role="alert" className="field-error">{error}</p>}
    </div>
  );
}
