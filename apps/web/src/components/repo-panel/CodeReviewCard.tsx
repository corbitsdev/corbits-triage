import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import type { RepoSource } from "@corbits/triage-contracts";
import { usePortal } from "../../lib/portal.tsx";
import { useCodeReviewAwaitsUpgrade } from "../../lib/triage-upgrade.ts";

function Move({ title, why, act, to }: { title: string; why: string; act: string; to: string }) {
  return (
    <section className="rs review" aria-labelledby="rs-review" id="rp-review">
      <h3 id="rs-review">Code review</h3>
      <section className="move" aria-labelledby="review-move-title">
        <header>
          <b id="review-move-title">{title}</b>
          <span>{why}</span>
        </header>
        <div className="acts">
          <Button asChild size="sm"><Link to={to}>{act}</Link></Button>
        </div>
      </section>
    </section>
  );
}

/** Code review is set in the repository's policy file; this card only says when something keeps it from running. */
export default function CodeReviewCard({ source }: { source: RepoSource }) {
  const { snapshot } = usePortal();
  const awaitsUpgrade = useCodeReviewAwaitsUpgrade(source);
  if (snapshot?.codeReviewPlace === null) {
    return <Move title="Code review needs an isolated place to run" why="Each review runs apart from everything else, and this server has no such place set up yet." act="Set one up" to="/settings/code-review" />;
  }
  if (awaitsUpgrade) {
    return <Move title="Code review starts after an upgrade" why="The Anthropic key is saved, but the version of Triage running now does not review code." act="Upgrade" to="/settings/triage" />;
  }
  return null;
}
