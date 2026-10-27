import { useState, type ReactNode } from "react";
import { Button } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import type { HubCredential } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";

type KeyRowProps = {
  words: ReactNode;
  name: string;
  keys: HubCredential[];
  denied: boolean;
  remove: (credentialId: string) => Promise<void>;
  editor: (onSaved: () => void) => ReactNode;
  /** Opens the form again to replace a stored key. The form starts empty; the stored key is not shown. */
  replaceLabel?: string;
};

/** One model and its key: a stored key can be replaced or removed; without one, its form is open. Without access to credentials, only the sentence shows. */
export function KeyRow({ words, name, keys, denied, remove, editor, replaceLabel = "Change" }: KeyRowProps) {
  const { readOnly } = usePortal();
  const [editing, setEditing] = useState(false);
  const removal = useMutation({
    mutationFn: async function removeKeys() {
      if (!window.confirm(`Remove the ${name} key? What uses it stops working.`)) return;
      for (const key of keys) await remove(key.id);
    },
  });
  const stored = keys.length > 0;

  if (denied) return <div className="sentence"><span className="txt">{words}</span></div>;

  return (
    <>
      <div className="sentence">
        <span className="txt">{words}</span>
        <span className="key-acts">
          <span className="model">{stored ? "Key stored" : "No key"}</span>
          {stored && <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => setEditing(!editing)}>{editing ? "Cancel" : replaceLabel}</Button>}
          {stored && <Button type="button" variant="ghost" size="sm" disabled={readOnly || removal.isPending} onClick={() => removal.mutate()}>Remove</Button>}
        </span>
      </div>
      {(!stored || editing) && editor(() => setEditing(false))}
      {removal.error && <p role="alert" className="field-error">Could not remove the {name} key. {errorText(removal.error)}</p>}
    </>
  );
}
