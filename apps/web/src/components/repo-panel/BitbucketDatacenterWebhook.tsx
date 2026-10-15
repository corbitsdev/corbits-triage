import type { BitbucketDatacenterEnabled } from "../../lib/hub-api.ts";
import { CopyField } from "../CopyField.tsx";

type Manual = Extract<BitbucketDatacenterEnabled, { webhook: "manual" }>;

/** Shown once after turning triage on with a token that may not manage webhooks; the secret is not shown again. */
export default function BitbucketDatacenterWebhook({ webhook }: { webhook: Manual }) {
  return (
    <div className="gcard" role="region" aria-labelledby="rp-bbdc-hook">
      <header>
        <b id="rp-bbdc-hook">Set up the webhook on Bitbucket</b>
        <span>The token may not manage webhooks, so a repository admin opens Repository settings → Webhooks → Create webhook, names it Corbits Triage, pastes this URL and secret, selects these events and saves.</span>
      </header>
      <div className="source-body">
        <CopyField label="Webhook URL" value={webhook.hookUrl} />
        <CopyField label="Webhook secret" value={webhook.hookSecret} />
        <p className="mono small-text">{webhook.events.join(", ")}</p>
      </div>
    </div>
  );
}
