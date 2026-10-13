import { Button, CorbitsMark } from "@corbits/react-ui";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../error-text.ts";
import { githubToken, onboarded, systemOne } from "../storage.ts";
import { DecisionModelForm } from "./DecisionModelForm.tsx";
import { openExamplePr } from "./example-pr.ts";
import { GithubTokenForm } from "./GithubTokenForm.tsx";
import { useStorageItem } from "./use-storage.ts";

type Step = "intro" | "pin" | "model" | "token" | "done";

const STEPS: Array<{ id: Step; name: string; optional?: true }> = [
  { id: "intro", name: "Welcome" },
  { id: "pin", name: "Pin" },
  { id: "model", name: "Decision model", optional: true },
  { id: "token", name: "GitHub token", optional: true },
  { id: "done", name: "Done" },
];

function Progress({ step }: { step: Step }) {
  const at = STEPS.findIndex((each) => each.id === step);
  return (
    <ol className="welcome-progress" aria-label="Setup steps">
      {STEPS.map((each, index) => (
        <li key={each.id} data-state={index < at ? "done" : index === at ? "current" : "next"} aria-current={index === at ? "step" : undefined}>
          <span className="welcome-dot mono">{index < at ? <Check aria-hidden="true" /> : index + 1}</span>
          <span className="welcome-step-name">{each.name}{each.optional ? <small>Optional</small> : null}</span>
        </li>
      ))}
    </ol>
  );
}

/** The full-page first run, opened in a tab on install; finishing it in the panel brings this tab to its last step. */
export function Welcome() {
  const done = useStorageItem(onboarded);
  const model = useStorageItem(systemOne);
  const token = useStorageItem(githubToken);
  const [step, setStep] = useState<Step>("intro");
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const moved = useRef(false);

  useEffect(function doneElsewhere() {
    if (done) setStep("done");
  }, [done]);

  // The button that moved the step goes with it, so focus moves to the new step's heading.
  useEffect(function focusStep() {
    if (moved.current) cardRef.current?.querySelector("h1")?.focus();
    moved.current = true;
  }, [step]);

  if (done === undefined || model === undefined || token === undefined) return null;

  function go(next: Step) {
    return function move() {
      setStep(next);
    };
  }

  async function openExample() {
    setError(null);
    try {
      await openExamplePr();
      await onboarded.setValue(true);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function finish() {
    setError(null);
    try {
      await onboarded.setValue(true);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <main className="welcome">
      <p className="brand"><CorbitsMark decorative className="mark" />Corbits Triage</p>
      <section className="welcome-card" ref={cardRef} aria-labelledby="welcome-title">
        <Progress step={step} />
        {step === "intro" ? (
          <div className="welcome-body">
            <h1 id="welcome-title" tabIndex={-1}>Triage scores the pull request in front of you</h1>
            <p>Its score, what to do next and the checks behind it, read from GitHub as you. Setup takes a minute.</p>
            <div className="row"><Button size="lg" onClick={go("pin")}>Get started</Button></div>
          </div>
        ) : null}
        {step === "pin" ? (
          <div className="welcome-body">
            <h1 id="welcome-title" tabIndex={-1}>Pin Triage to your toolbar</h1>
            <ol className="pin-steps">
              <li>Open the extensions menu, the puzzle piece in the toolbar, and pin Corbits Triage.</li>
              <li>On a pull request, click the Triage icon or the score beside the title.</li>
            </ol>
            <div className="row">
              <Button size="lg" onClick={go("model")}>Continue</Button>
              <Button size="lg" variant="ghost" onClick={go("intro")}>Back</Button>
            </div>
          </div>
        ) : null}
        {step === "model" ? (
          <div className="welcome-body">
            <h1 id="welcome-title" tabIndex={-1}>Add a decision model</h1>
            <p>Optional. Answers the checks that need judgement, like whether a change is focused. You can add one later in Settings.</p>
            <DecisionModelForm current={model} variant="primary" onSaved={go("token")} />
            <div className="row">
              {model ? <Button size="lg" onClick={go("token")}>Continue</Button> : <button type="button" className="text-button" onClick={go("token")}>Skip for now</button>}
              <Button size="lg" variant="ghost" onClick={go("pin")}>Back</Button>
            </div>
          </div>
        ) : null}
        {step === "token" ? (
          <div className="welcome-body">
            <h1 id="welcome-title" tabIndex={-1}>Add a GitHub token</h1>
            <p>Optional. Only used when a page cannot be read as you, for 5,000 GitHub calls an hour instead of 60.</p>
            <GithubTokenForm variant="primary" onSaved={finish} />
            <div className="row">
              {token ? <Button size="lg" onClick={finish}>Continue</Button> : <button type="button" className="text-button" onClick={finish}>Skip for now</button>}
              <Button size="lg" variant="ghost" onClick={go("model")}>Back</Button>
            </div>
          </div>
        ) : null}
        {step === "done" ? (
          <div className="welcome-body">
            <h1 id="welcome-title" tabIndex={-1}>You're set</h1>
            <p>Click the score beside a pull request's title, or Corbits Triage in the toolbar. A short tour shows the rest on an example.</p>
            <div className="row"><Button size="lg" onClick={openExample}>Open an example pull request</Button></div>
          </div>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
