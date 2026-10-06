// SPDX-License-Identifier: GPL-2.0-only
import { useState, type FormEvent } from "react";
import { DECISION_MODEL_PRESETS, presetFor, type DecisionModelPreset } from "../lib/decision-models.ts";
import { usePortal } from "../lib/portal.tsx";

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
      setError(`Could not save the decision model. ${cause instanceof Error ? cause.message : String(cause)}`);
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
      <label>Base URL<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://…/v1" disabled={disabled} autoComplete="off" /><small>A System One–compatible API; requests go to this URL + /systemone.</small></label>
      <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} disabled={disabled} autoComplete="off" /></label>
    </>}
    <label>{preset.keyLabel}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={disabled} autoComplete="off" /><small>Stored in the hub's credential vault. You won't see it again.</small></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="task-actions"><button type="submit" className="btn primary" disabled={disabled || !apiKey.trim() || (custom && (!endpoint.trim() || !model.trim()))}>{saving ? "Saving…" : "Save decision model"}</button></div>
  </form>;
}
