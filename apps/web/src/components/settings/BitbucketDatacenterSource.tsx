import { useId, useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { useBitbucketDatacenterConnection, useConnectBitbucketDatacenter, useDisconnectBitbucketDatacenter } from "../../lib/bitbucket-datacenter.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyField } from "../CopyField.tsx";

function connectBlocker(baseUrl: string, token: string): string | null {
  if (!baseUrl.trim()) return "Enter the instance URL to connect.";
  if (!token.trim()) return "Paste an HTTP access token to connect.";
  return null;
}

function ConnectForm({ disabled }: { disabled: boolean }) {
  const connect = useConnectBitbucketDatacenter();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const blocker = connectBlocker(baseUrl, token);
  const blockerId = useId();
  const busy = disabled || connect.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    connect.mutate({ baseUrl: baseUrl.trim(), token: token.trim() }, { onSuccess: () => setToken("") });
  }

  return (
    <form className="connection-fields" aria-label="Connect Bitbucket Data Center" onSubmit={submit}>
      <label>Instance URL<Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://bitbucket.example.com" disabled={busy} autoComplete="off" /></label>
      <label>HTTP access token<Input type="password" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} autoComplete="off" /><small>Create a user named Corbits Triage and an HTTP access token for that user, so Triage's posts show under that name, not a person's. It needs project read and repository write, and repository admin so Triage can create each repository's webhook.</small></label>
      <a className="linkish quiet" href="/corbits-triage-avatar.png" download>Download the Corbits Triage avatar</a>
      {connect.error && <p role="alert" className="error">Could not connect Bitbucket Data Center. {errorText(connect.error)}</p>}
      <div className="task-actions">
        <Button type="submit" aria-describedby={blockerId} disabled={busy || blocker !== null}>{connect.isPending ? "Connecting…" : "Connect"}</Button>
        <small id={blockerId} className="muted" aria-live="polite">{blocker}</small>
      </div>
    </form>
  );
}

export function BitbucketDatacenterSource() {
  const { readOnly } = usePortal();
  const connection = useBitbucketDatacenterConnection();
  const disconnect = useDisconnectBitbucketDatacenter();
  const connected = connection.data;

  function confirmDisconnect() {
    if (!window.confirm("Disconnect Bitbucket Data Center? Triage stops on every Bitbucket Data Center repository and removes the webhooks it created.")) return;
    disconnect.mutate();
  }

  return (
    <div className="gcard source" aria-labelledby="source-bitbucket-datacenter" role="group">
      <header>
        <b id="source-bitbucket-datacenter">Bitbucket Data Center</b>
        <span>An HTTP access token lets Triage read pull requests on your instance and act on them.</span>
      </header>
      <div className="source-body">
        {connection.error && <p role="alert" className="error">Could not read the Bitbucket Data Center connection. {errorText(connection.error)}</p>}
        {disconnect.error && <p role="alert" className="error">Could not disconnect Bitbucket Data Center. {errorText(disconnect.error)}</p>}
        {disconnect.data && disconnect.data.webhooksLeft.length > 0 && <p role="alert" className="error">Delete the Corbits Triage webhook by hand on {disconnect.data.webhooksLeft.join(", ")}; Triage could not remove it.</p>}
        {connection.data !== undefined && (
          <div className="sentences">
            <div className="sentence">
              <span className="txt">{connected ? <>Connected to <b className="mono small-text">{connected.baseUrl}</b>.</> : "Bitbucket Data Center is not connected."}</span>
              {connected && <Button type="button" variant="outline" size="sm" disabled={readOnly || disconnect.isPending} onClick={confirmDisconnect}>{disconnect.isPending ? "Disconnecting…" : "Disconnect"}</Button>}
            </div>
          </div>
        )}
        {connection.data === null && <ConnectForm disabled={readOnly} />}
        {connected && <CopyField label="Webhook URL" value={connected.hookUrl} help="Bitbucket Data Center sends pull request events here. Triage creates each repository's webhook when you turn triage on, if the token allows it." />}
      </div>
    </div>
  );
}
