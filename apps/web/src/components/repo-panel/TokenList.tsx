import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type TokenListProps = {
  values: string[];
  /** What one value is, for the add control and each remove button. */
  noun: string;
  placeholder?: string;
  mono?: boolean;
  disabled: boolean;
  onChange: (values: string[]) => void;
};

/** A list of short values as removable chips, added one at a time. */
export default function TokenList({ values, noun, placeholder, mono, disabled, onChange }: TokenListProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  /** Set when the focused control is about to disappear, so focus lands on the add button rather than the page. */
  const refocus = useRef(false);

  useEffect(function returnFocusToAdd() {
    if (adding || !refocus.current) return;
    refocus.current = false;
    addRef.current?.focus();
  });

  function remove(value: string) {
    refocus.current = true;
    onChange(values.filter((item) => item !== value));
  }

  function commit() {
    const value = text.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setText("");
    setAdding(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      refocus.current = true;
      commit();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      refocus.current = true;
      setText("");
      setAdding(false);
    }
  }

  return (
    <span className="tokens">
      {values.map((value) => (
        <span key={value} className="glob">{value}<button type="button" aria-label={`Remove ${value}`} disabled={disabled} onClick={() => remove(value)}>×</button></span>
      ))}
      {adding
        ? <input className={mono ? "val w mono-val" : "val w"} aria-label={`Add ${noun}`} placeholder={placeholder} autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} onBlur={commit} />
        : <button type="button" className="linkish" ref={addRef} disabled={disabled} onClick={() => setAdding(true)}>Add {noun}</button>}
    </span>
  );
}
