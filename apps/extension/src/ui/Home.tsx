import { Button } from "@corbits/react-ui";
import { prKey } from "../pr.ts";
import { views } from "../storage.ts";
import { stateName, toneOf, type TriageView } from "../view.ts";
import { openExamplePr, openPr } from "./example-pr.ts";
import { useStorageItem } from "./use-storage.ts";

const RECENT = 8;

function RecentRow({ view }: { view: TriageView }) {
  async function open() {
    await openPr(`https://github.com/${view.pr.repo}/pull/${view.pr.number}`);
  }

  return (
    <li>
      <button type="button" className="recent" onClick={open}>
        <span className="recent-score mono" data-tone={toneOf(view)}>{view.readiness ?? "–"}</span>
        <span className="recent-body">
          <b>{view.title}</b>
          <span>{stateName(view)} · <span className="mono">{view.pr.repo} #{view.pr.number}</span></span>
        </span>
      </button>
    </li>
  );
}

export function Home() {
  const all = useStorageItem(views);
  if (all === undefined) return null;
  const recent = Object.values(all).sort((a, b) => b.ranAt.localeCompare(a.ranAt)).slice(0, RECENT);
  return (
    <div className="home">
      <h1 tabIndex={-1}>Open a pull request</h1>
      {recent.length ? (
        <section className="part" aria-labelledby="recent-head">
          <h2 id="recent-head">Recent</h2>
          <ul className="recents">{recent.map((view) => <RecentRow key={prKey(view.pr)} view={view} />)}</ul>
        </section>
      ) : <div className="row"><Button size="sm" variant="outline" onClick={openExamplePr}>Open an example</Button></div>}
    </div>
  );
}
