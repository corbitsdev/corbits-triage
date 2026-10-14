import { useId, useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DECISION_MODEL_PRESETS, presetFor, type DecisionModelPreset } from "@corbits/triage-contracts";
import { hasDecisionModelCredential } from "../lib/decision-models.ts";
import { usePortal } from "../lib/portal.tsx";

type Draft = { custom: boolean; endpoint: string; model: string; apiKey: string };

function saveBlocker({ custom, endpoint, model, apiKey }: Draft): string | null {
  if (custom && !endpoint.trim()) return "Enter the base URL to save.";
  if (custom && !model.trim()) return "Enter the model to save.";
  if (!apiKey.trim()) return "Paste the API key to save.";
  return null;
}

function keyHelp(stored: boolean): string {
  if (stored) return "A key is stored in the hub's credential vault. Paste a new one to replace it.";
  return "Stored in the hub's credential vault. You won't see it again.";
}

export function DecisionModelForm() {
  const { snapshot, saveInferenceSecret, readOnly } = usePortal();
  const saved = snapshot?.config?.inference;
  const [preset, setPreset] = useState<DecisionModelPreset>(presetFor(saved));
  const [endpoint, setEndpoint] = useState(saved?.endpoint ?? "");
  const [model, setModel] = useState(saved?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const custom = preset.id === "custom";
  const disabled = readOnly || saving;
  const stored = snapshot !== null && hasDecisionModelCredential(snapshot.credentials);
  const blocker = saveBlocker({ custom, endpoint, model, apiKey });
  const blockerId = useId();

  function choose(next: DecisionModelPreset) {
    setPreset(next);
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await saveInferenceSecret({
        endpoint: custom ? endpoint : preset.endpoint,
        model: custom ? model : preset.model,
        secret: apiKey,
      });
      setApiKey("");
    } catch (cause) {
      setError(`Could not save the decision model. ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  function renderPreset(option: DecisionModelPreset) {
    return <button key={option.id} type="button" role="radio" aria-checked={option.id === preset.id} disabled={disabled} onClick={() => choose(option)}>{option.label}</button>;
  }

  return <form className="connection-fields" aria-label="Decision model" onSubmit={submit}>
    <div className="segmented" role="radiogroup" aria-label="Provider">{DECISION_MODEL_PRESETS.map(renderPreset)}</div>
    {custom && <>
      <label>Base URL<Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://…/v1" disabled={disabled} autoComplete="off" /><small>A System One–compatible API; requests go to this URL + /systemone.</small></label>
      <label>Model<Input value={model} onChange={(event) => setModel(event.target.value)} disabled={disabled} autoComplete="off" /></label>
    </>}
    <label>{preset.keyLabel}<Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={disabled} autoComplete="off" /><small>{keyHelp(stored)}</small></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="task-actions">
      <Button type="submit" aria-describedby={blockerId} disabled={disabled || blocker !== null}>{saving ? "Saving…" : "Save decision model"}</Button>
      <small id={blockerId} className="muted" aria-live="polite">{blocker}</small>
    </div>
  </form>;
}
