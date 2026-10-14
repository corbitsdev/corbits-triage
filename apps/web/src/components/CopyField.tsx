import { useId, type FocusEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";

/** Copies `value`, and says so on the button; a refused clipboard asks for a manual copy. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const copy = useMutation({
    mutationFn: async function writeClipboard() {
      await navigator.clipboard.writeText(value);
    },
  });
  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-label={label} onClick={() => copy.mutate()}>{copy.isSuccess ? "Copied" : "Copy"}</Button>
      <span role="status" className="sr-only">{copy.isSuccess ? "Copied." : ""}</span>
      {copy.isError && <span role="alert" className="field-error">Could not copy. Select the text and copy it.</span>}
    </>
  );
}

function selectAll(event: FocusEvent<HTMLInputElement>) {
  event.currentTarget.select();
}

type CopyFieldProps = {
  label: string;
  value: string;
  /** One sentence saying where the value goes. */
  help?: string;
  className?: string;
};

export function CopyField({ label, value, help, className }: CopyFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className={className ? `copy-field-row ${className}` : "copy-field-row"}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="copy-field">
        <Input id={id} readOnly value={value} onFocus={selectAll} aria-describedby={help ? helpId : undefined} />
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {help && <p id={helpId} className="field-help">{help}</p>}
    </div>
  );
}
