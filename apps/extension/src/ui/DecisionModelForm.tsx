import { Button, Input, type ButtonProps } from "@corbits/react-ui";
import { DECISION_MODEL_PRESETS, presetFor, type DecisionModelPreset } from "@corbits/triage-contracts";
import { Check } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { systemOne } from "../storage.ts";
import type { SystemOneSettings } from "../system-one.ts";
import { errorText } from "../error-text.ts";
import { onRadioKeys } from "./radio-keys.ts";

type DecisionModelFormProps = { current: SystemOneSettings | null; onSaved?: () => void; onCancel?: () => void; variant?: ButtonProps["variant"] };

/** Official marks from each provider's own site; light-theme art first, dark second where the provider ships both. */
const LOGOS: Partial<Record<DecisionModelPreset["id"], readonly [string, string?]>> = {
  typesafe: ["/providers/typesafe.png"],
  vercel: ["/providers/vercel-light.svg", "/providers/vercel-dark.svg"],
  opencode: ["/providers/opencode-light.svg", "/providers/opencode-dark.svg"],
};

function ProviderLogo({ id }: { id: DecisionModelPreset["id"] }) {
  const logo = LOGOS[id];
  if (!logo) return null;
  const [light, dark] = logo;
  return (
    <span className="provider-logo" aria-hidden="true">
      <img src={light} alt="" className={dark ? "on-light" : undefined} />
      {dark ? <img src={dark} alt="" className="on-dark" /> : null}
    </span>
  );
}

function Saved({ current, onChange, onRemove }: { current: SystemOneSettings; onChange: () => void; onRemove: () => void }) {
  const preset = presetFor(current);
  return (
    <div className="saved-setting">
      <div className="saved-provider">
        <ProviderLogo id={preset.id} />
        <div>
          <p className="saved-line"><Check className="saved-mark" aria-hidden="true" />{preset.id === "custom" ? new URL(current.endpoint).host : preset.label}</p>
          <p className="hint mono">{current.model}</p>
        </div>
      </div>
      <div className="row">
        <Button type="button" size="sm" variant="outline" onClick={onChange}>Change</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}

/** The portal's decision model choice; the key stays in this browser's extension storage and goes only to that endpoint. */
export function DecisionModelForm({ current, onSaved, onCancel, variant }: DecisionModelFormProps) {
  const [changing, setChanging] = useState(false);
  const [preset, setPreset] = useState<DecisionModelPreset>(presetFor(current ?? undefined));
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = useId();
  const custom = preset.id === "custom";
  const target = custom ? { endpoint: endpoint.trim(), model: model.trim() } : { endpoint: preset.endpoint, model: preset.model };
  const keptKey = current && current.endpoint === target.endpoint ? current.key : undefined;

  function choose(next: DecisionModelPreset) {
    setPreset(next);
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let origin: string;
    try {
      origin = new URL(target.endpoint).origin;
    } catch {
      setError("The base URL must be a full URL, starting with https://.");
      return;
    }
    if (!key.trim() && !keptKey) {
      setError(current ? "Paste the key again: a saved key only goes to the endpoint it was saved for." : "Paste a key first.");
      return;
    }
    setSaving(true);
    try {
      // Asked for in the click itself: the browser grants host access only inside a user gesture.
      const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error(`Triage needs access to ${origin} to ask the decision model. Save again and allow it.`);
      await systemOne.setValue({ ...target, key: key.trim() || keptKey! });
    } catch (cause) {
      setError(errorText(cause));
      return;
    } finally {
      setSaving(false);
    }
    setKey("");
    setChanging(false);
    onSaved?.();
  }

  async function remove() {
    setError(null);
    try {
      await systemOne.setValue(null);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    setChanging(false);
  }

  function change() {
    setChanging(true);
  }

  function cancel() {
    setChanging(false);
    setError(null);
    onCancel?.();
  }

  if (current && !changing) {
    return (
      <>
        <Saved current={current} onChange={change} onRemove={remove} />
        {error ? <p className="error" role="alert">{error}</p> : null}
      </>
    );
  }

  return (
    <form className="form" aria-label="Decision model" onSubmit={save}>
      <div className="providers" role="radiogroup" aria-label="Provider" onKeyDown={onRadioKeys}>
        {DECISION_MODEL_PRESETS.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={option.id === preset.id} tabIndex={option.id === preset.id ? 0 : -1} className="provider" onClick={() => choose(option)}>
            <ProviderLogo id={option.id} />
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      {custom ? (
        <>
          <div className="field">
            <label htmlFor={`${ids}-url`}>Base URL</label>
            <Input id={`${ids}-url`} type="url" value={endpoint} placeholder="https://…/v1" required autoComplete="off" aria-describedby={`${ids}-url-hint`} onChange={(event) => setEndpoint(event.target.value)} />
            <p className="hint" id={`${ids}-url-hint`}>A System One–compatible API; requests go to this URL + /systemone.</p>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-model`}>Model</label>
            <Input id={`${ids}-model`} className="mono" value={model} required autoComplete="off" onChange={(event) => setModel(event.target.value)} />
          </div>
        </>
      ) : null}
      <div className="field">
        <label htmlFor={`${ids}-key`}>{preset.keyLabel}</label>
        <Input id={`${ids}-key`} type="password" autoComplete="off" spellCheck={false} value={key} placeholder={keptKey ? "Saved. Paste a new key to replace it." : "Paste your key"} required={!keptKey} aria-describedby={`${ids}-key-hint`} onChange={(event) => setKey(event.target.value)} />
        <p className="hint" id={`${ids}-key-hint`}>The key stays in this browser and goes only to this provider.</p>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <Button type="submit" size="sm" variant={variant} disabled={saving}>{saving ? "Saving…" : "Save decision model"}</Button>
        {current || onCancel ? <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
