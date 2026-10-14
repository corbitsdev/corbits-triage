import { Button } from "@corbits/react-ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { listSessions, revokeSession, type HubSessionRow } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";

const SESSIONS_QUERY_KEY = "hub-sessions";

async function readSessions(): Promise<HubSessionRow[]> {
  return listSessions(createHubTransport());
}

function deviceName(session: HubSessionRow): string {
  if (session.isCurrent) return "This browser";
  return session.userAgent ?? "Unknown device";
}

/** Each device signed in as you, as sentence rows; any but this one can be signed out. */
export function SignedInDevices() {
  const query = useQuery({ queryKey: [SESSIONS_QUERY_KEY], queryFn: readSessions });
  const signOut = useMutation({
    mutationFn: async function revoke(session: HubSessionRow) {
      await revokeSession(createHubTransport(), session.id);
    },
    onSettled: async function reread() {
      await query.refetch();
    },
  });

  if (query.error) return <p role="alert" className="field-error">{query.error.message}</p>;
  if (!query.data) return null;
  return (
    <>
      {query.data.map((session) => (
        <div key={session.id} className="sentence">
          <span className="txt">{deviceName(session)} <span className="model">since {new Date(session.createdAt).toLocaleString()}</span></span>
          {!session.isCurrent && <Button type="button" variant="outline" size="sm" aria-label={`Sign out ${deviceName(session)}`} disabled={signOut.isPending} onClick={() => signOut.mutate(session)}>Sign out</Button>}
        </div>
      ))}
      {signOut.error && <p role="alert" className="field-error">{errorText(signOut.error)}</p>}
    </>
  );
}
