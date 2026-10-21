import { CorbitsMark } from "@corbits/react-ui";
import { Settings } from "./Settings.tsx";

/** The extension's settings; a pull request's result shows on its own page. */
export function Panel() {
  return (
    <div className="panel">
      <header className="panel-header">
        <CorbitsMark decorative className="mark" />
        <h1 className="brand">Corbits Triage</h1>
      </header>
      <main className="panel-main">
        <Settings />
      </main>
    </div>
  );
}
