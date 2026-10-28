import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import { usePortal } from "../../lib/portal.tsx";

/** Code review is set in the repository's policy file; this card only says when the server has nowhere to run it. */
export default function CodeReviewCard() {
  const { snapshot } = usePortal();
  if (snapshot?.codeReviewPlace !== null) return null;
  return (
    <section className="rs review" aria-labelledby="rs-review" id="rp-review">
      <h3 id="rs-review">Code review</h3>
      <section className="move" aria-labelledby="review-place-title">
        <header>
          <b id="review-place-title">Code review needs an isolated place to run</b>
          <span>Each review runs apart from everything else, and this server has no such place set up yet.</span>
        </header>
        <div className="acts">
          <Button asChild size="sm"><Link to="/settings/code-review">Set one up</Link></Button>
        </div>
      </section>
    </section>
  );
}
