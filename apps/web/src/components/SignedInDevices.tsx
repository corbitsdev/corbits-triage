import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listHubSessions, revokeHubSession, type HubDeviceSession } from "../lib/hub-auth.ts";

const SESSIONS_QUERY_KEY = "hub-sessions";

export function SignedInDevices() {
  const query = useQuery({ queryKey: [SESSIONS_QUERY_KEY], queryFn: listHubSessions });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function revoke(session: HubDeviceSession) {
    setPending(session.token);
    setError("");
    try {
      await revokeHubSession(session.token);
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
        <div key={session.token} className="row">
          <span>{session.userAgent ?? "Unknown device"} · since {new Date(session.createdAt).toLocaleString()}</span>
          <button type="button" className="btn" disabled={pending !== null} onClick={() => void revoke(session)}>Sign out</button>
        </div>
      ))}
      {error && <p role="alert" className="field-error">{error}</p>}
    </div>
  );
}
