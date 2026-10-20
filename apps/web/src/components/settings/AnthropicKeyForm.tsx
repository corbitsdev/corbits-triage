import { useId, useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { DialogBody, DialogFieldLabel, DialogFooter } from "@corbits/react-ui/ui/dialog";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { usePortal } from "../../lib/portal.tsx";

export const ANTHROPIC_KEY_SAVE = ["save-key", "anthropic"];

export type KeyFormProps = {
  layout: "row" | "popup";
  submitLabel: string;
  onCancel: (() => void) | null;
  /** Called from the save itself, so a form that is gone by the time the save finishes calls nothing. */
  onSaved: () => void;
};

export function AnthropicKeyForm({ layout, submitLabel, onCancel, onSaved }: KeyFormProps) {
  const { saveAnthropic, readOnly } = usePortal();
  const [key, setKey] = useState("");
  const inputId = useId();
  const save = useMutation({
    mutationKey: ANTHROPIC_KEY_SAVE,
    mutationFn: saveAnthropic,
    onSuccess: function clearKey() {
      setKey("");
    },
  });
  const disabled = readOnly || save.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(key, { onSuccess: onSaved });
  }

  const input = <Input id={inputId} className="val w" type="password" placeholder="sk-ant-…" value={key} onChange={(event) => setKey(event.target.value)} disabled={disabled} autoComplete="off" />;
  const error = save.error && <p role="alert" className="field-error">Could not save the Anthropic key. {errorText(save.error)}</p>;
  const cancel = onCancel && <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={onCancel}>Cancel</Button>;
  const submitButton = <Button type="submit" size="sm" disabled={disabled || !key.trim()}>{save.isPending ? "Saving…" : submitLabel}</Button>;

  if (layout === "popup") {
    return (
      <form aria-label="Anthropic key" onSubmit={submit}>
        <DialogBody className="connection-fields">
          <DialogFieldLabel htmlFor={inputId}>Anthropic key</DialogFieldLabel>
          {input}
          <small>You won't see it again.</small>
          {error}
        </DialogBody>
        <DialogFooter>{cancel}{submitButton}</DialogFooter>
      </form>
    );
  }

  return (
    <form className="sentence" aria-label="Anthropic key" onSubmit={submit}>
      <div className="rmain">
        <label className="rline" htmlFor={inputId}>
          <span className="w">Anthropic key</span>
          {input}
        </label>
        {error}
      </div>
      <span className="key-acts">{cancel}{submitButton}</span>
    </form>
  );
}
