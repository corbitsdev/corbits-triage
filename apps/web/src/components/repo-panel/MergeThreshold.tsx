import { useEffect, useState } from "react";

type MergeThresholdProps = { value: number; disabled: boolean; onChange: (value: number) => void; invalid: boolean };

/** The field takes points, like every score the portal shows; the pack stores 0 to 1. */
function parse(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text) / 100;
}

function pointsText(value: number): string {
  return String(Math.round(value * 100));
}

/** The lowest model score at which a pull request whose checks all pass reads as ready to merge. */
export default function MergeThreshold({ value, disabled, onChange, invalid }: MergeThresholdProps) {
  const [text, setText] = useState(pointsText(value));

  // Discard and reload change the value from outside; typing keeps what was typed, even half a number.
  useEffect(function syncFromDraft() {
    setText((current) => (Object.is(parse(current), value) ? current : pointsText(value)));
  }, [value]);

  function change(next: string) {
    setText(next);
    onChange(parse(next));
  }

  return (
    <section className="rs" aria-labelledby="rs-merge">
      <h3 id="rs-merge">Merge verdict</h3>
      <div className={invalid ? "sentence invalid" : "sentence"} id="rp-merge">
        <span className="txt">Merge score threshold<small>Ready to merge when every check passes and the weakest model answer scores at least this, from 0 to 100.</small></span>
        <input className="val" type="number" aria-label="Merge score threshold" min={0} max={100} step={1} disabled={disabled} value={text} onChange={(event) => change(event.target.value)} />
      </div>
      {invalid ? <p className="reason">Enter a score from 0 to 100.</p> : null}
    </section>
  );
}
