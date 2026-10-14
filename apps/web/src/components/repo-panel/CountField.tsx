import { useState } from "react";

type CountFieldProps = { value: number | undefined; label: string; min: number; max?: number; disabled: boolean; onChange: (value: number) => void };

function parse(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

function shown(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** A whole number inside a sentence; an emptied field stays empty and reads as not a number until something is typed. */
export default function CountField({ value, label, min, max, disabled, onChange }: CountFieldProps) {
  const [text, setText] = useState(shown(value));
  const [synced, setSynced] = useState(value);

  // A reload or another writer changes the value from outside; typing keeps what was typed.
  if (!Object.is(synced, value)) {
    setSynced(value);
    if (value !== undefined && !Object.is(parse(text), value)) setText(String(value));
  }

  function change(next: string) {
    setText(next);
    onChange(parse(next));
  }

  return <input className="val" type="number" min={min} max={max} step={1} aria-label={label} disabled={disabled} value={text} onChange={(event) => change(event.target.value)} />;
}
