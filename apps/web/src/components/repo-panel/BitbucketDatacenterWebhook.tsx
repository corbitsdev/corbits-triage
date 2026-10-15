import type { BitbucketDatacenterManualWebhook } from "../../lib/hub-api.ts";
import { CopyField } from "../CopyField.tsx";

/** Shown while triage is on and the token could not create the webhook; open right after triage is turned on here. */
export default function BitbucketDatacenterWebhook({ webhook, open }: { webhook: BitbucketDatacenterManualWebhook; open: boolean }) {
  return (
    <details className="gcard" open={open}>
      <summary><b>Webhook setup</b></summary>
      <header>
        <span>The token may not manage webhooks, so a repository admin opens Repository settings → Webhooks → Create webhook, names it Corbits Triage, pastes this URL and secret, selects these events and saves.</span>
      </header>
      <div className="source-body">
        <CopyField label="Webhook URL" value={webhook.hookUrl} />
        <CopyField label="Webhook secret" value={webhook.hookSecret} />
        <p className="mono small-text">{webhook.events.join(", ")}</p>
      </div>
    </details>
  );
}
