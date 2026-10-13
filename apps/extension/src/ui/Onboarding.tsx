import { Button } from "@corbits/react-ui";
import { useEffect, useRef, useState } from "react";
import { onboarded } from "../storage.ts";
import { openExamplePr } from "./example-pr.ts";

type Step = "intro" | "pin";

async function finish() {
  await onboarded.setValue(true);
}

async function finishOnExample() {
  await openExamplePr();
  await finish();
}

/** The first-run steps in the side panel, until they are finished or skipped here or on the welcome page. */
export function Onboarding() {
  const [step, setStep] = useState<Step>("intro");
  const stepRef = useRef<HTMLElement>(null);
  const moved = useRef(false);

  // The button that moved the step goes with it, so focus moves to the new step's heading.
  useEffect(function focusStep() {
    if (moved.current) stepRef.current?.querySelector("h1")?.focus();
    moved.current = true;
  }, [step]);

  function next() {
    setStep("pin");
  }

  function back() {
    setStep("intro");
  }

  return (
    <div className="onboarding">
      {step === "intro" ? (
        <section className="onboarding-step" ref={stepRef}>
          <h1 tabIndex={-1}>Triage scores the pull request in front of you</h1>
          <p>Its score, what to do next and the checks behind it, read from GitHub as you.</p>
          <div className="row">
            <Button onClick={next}>Get started</Button>
          </div>
        </section>
      ) : (
        <section className="onboarding-step" ref={stepRef}>
          <h1 tabIndex={-1}>Pin Triage, then open a pull request</h1>
          <ol className="pin-steps">
            <li>Open the extensions menu, the puzzle piece in the toolbar, and pin Corbits Triage.</li>
            <li>On a pull request, click the Triage icon or the score beside the title.</li>
          </ol>
          <div className="row">
            <Button onClick={finishOnExample}>Open an example pull request</Button>
            <Button variant="ghost" onClick={finish}>Done</Button>
            <Button variant="ghost" onClick={back}>Back</Button>
          </div>
        </section>
      )}
    </div>
  );
}
