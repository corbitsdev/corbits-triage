import type { PortalSnapshot } from "../../lib/hub-api.ts";
import { BitbucketDatacenterSource } from "./BitbucketDatacenterSource.tsx";
import { GithubSource } from "./GithubSource.tsx";

export function SourcesSection({ snapshot }: { snapshot: PortalSnapshot }) {
  return (
    <section className="sec" id="sources" aria-labelledby="sec-sources">
      <header>
        <h2 id="sec-sources">Sources</h2>
        <p>Where Triage reads pull requests from and acts on them.</p>
      </header>
      <div>
        <GithubSource snapshot={snapshot} />
        <BitbucketDatacenterSource />
      </div>
    </section>
  );
}
