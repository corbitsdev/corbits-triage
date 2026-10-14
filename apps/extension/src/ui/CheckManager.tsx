import { Badge, Button, ConfirmButton, Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { catalogSentence, CHECK_CATALOG, CUSTOM_CHECK_CAP, customSentence, isCatalogId, recommendedPack, RULE_KINDS, type CatalogId, type CheckPack, type CustomCheck, type RuleKind } from "@corbits/triage-contracts";
import { Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { send } from "../messages.ts";
import { changesFromDefaults, customFormOf, switchableChecks, withCheck, withoutCheck } from "../pack-edit.ts";
import { readLocalPack, resetLocalPack, savedPackFor, saveLocalPack } from "../pack-store.ts";
import type { PrRef } from "../pr.ts";
import { localPacks, systemOne } from "../storage.ts";
import { CatalogEditor, CustomEditor, EDITABLE_CATALOG } from "./CheckEditors.tsx";
import { useStorageItem } from "./use-storage.ts";

type Row = { id: string; on: boolean; sentence: string; model: boolean; custom: CustomCheck | undefined };

function rowsOf(pack: CheckPack): Row[] {
  return switchableChecks(pack).map(function describe({ id, on }): Row {
    if (isCatalogId(id)) return { id, on, sentence: catalogSentence(id, pack), model: CHECK_CATALOG[id].kind === "quality", custom: undefined };
    const custom = pack.custom.find((c) => c.id === id)!;
    return { id, on, sentence: customSentence(custom), model: custom.kind === "model", custom };
  });
}

function EvalBadge({ model }: { model: boolean }) {
  return <span className="eval">{model ? <Badge tone="info">Decision model</Badge> : <Badge tone="neutral">Rule</Badge>}</span>;
}

type Save = (change: (pack: CheckPack) => CheckPack, message: string) => Promise<boolean>;

type RowProps = {
  row: Row;
  pack: CheckPack;
  editing: boolean;
  onEdit: (id: string | null) => void;
  onSave: Save;
  locked: boolean;
};

function CheckRow({ row, pack, editing, onEdit, onSave, locked }: RowProps) {
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);

  // Closing the editor removes what had focus, so it returns to the button that opened it.
  useEffect(function refocusOnClose() {
    if (wasEditing.current && !editing) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const custom = row.custom;
  const label = custom?.name ?? CHECK_CATALOG[row.id as CatalogId].name;
  const editable = isCatalogId(row.id) ? EDITABLE_CATALOG.includes(row.id) : custom !== undefined;

  async function toggle(on: boolean) {
    await onSave((current) => withCheck(current, row.id, on), `${label} is ${on ? "on" : "off"}.`);
  }

  async function remove() {
    await onSave((current) => withoutCheck(current, row.id), `Removed ${label}.`);
  }

  async function saveEdit(next: CheckPack) {
    if (await onSave(() => next, `Saved ${label}.`)) onEdit(null);
  }

  function startEdit() {
    onEdit(editing ? null : row.id);
  }

  function stopEdit() {
    onEdit(null);
  }

  return (
    <li className="manage-row" data-on={row.on}>
      <div className="manage-head">
        <div className="manage-text">
          {custom ? <p className="manage-name">{custom.name}</p> : null}
          <p className="manage-sentence">{row.sentence}</p>
          {row.model ? <EvalBadge model /> : null}
        </div>
        <Switch checked={row.on && !locked} disabled={locked} label={label} onCheckedChange={toggle} />
      </div>
      <div className="row">
        {editable && row.on ? (
          <button type="button" ref={editRef} className="text-button" aria-expanded={editing} onClick={startEdit}>
            {editing ? "Close the editor" : isCatalogId(row.id) ? "Edit the limits" : "Edit the rule"}
          </button>
        ) : null}
        {custom ? <ConfirmButton size="sm" variant="ghost" confirmLabel={`Confirm: remove ${custom.name}`} onConfirm={remove}>Remove the rule</ConfirmButton> : null}
      </div>
      {editing && isCatalogId(row.id) ? <CatalogEditor id={row.id as CatalogId} pack={pack} onSave={saveEdit} onCancel={stopEdit} /> : null}
      {editing && custom ? (
        <CustomEditor shape={custom.shape} pack={pack} id={custom.id} form={customFormOf(custom)} defaultName={custom.name} onSave={saveEdit} onCancel={stopEdit} />
      ) : null}
    </li>
  );
}

function AddCheck({ pack, onSave }: { pack: CheckPack; onSave: Save }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<RuleKind | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const galleryRef = useRef<HTMLUListElement>(null);
  const wasOpen = useRef(open);
  const full = pack.custom.length >= CUSTOM_CHECK_CAP;

  // Opening moves focus into the gallery; closing returns it to the button, which the gallery replaced.
  useEffect(function moveFocus() {
    if (open && !kind) galleryRef.current?.querySelector("button")?.focus();
    if (wasOpen.current && !open) addRef.current?.focus();
    wasOpen.current = open;
  }, [open, kind]);

  async function add(next: CheckPack, id: string) {
    const name = next.custom.find((check) => check.id === id)?.name ?? "the rule";
    if (!(await onSave(() => next, `Added ${name}.`))) return;
    setKind(null);
    setOpen(false);
  }

  function cancel() {
    setKind(null);
    setOpen(false);
  }

  function start() {
    setOpen(true);
  }

  if (full) return <p className="hint">Up to {CUSTOM_CHECK_CAP} checks of your own. Remove one to add another.</p>;
  if (!open) return <Button ref={addRef} size="sm" variant="outline" onClick={start}><Plus aria-hidden="true" />Add a rule</Button>;
  if (kind) {
    return (
      <div className="add-check">
        <p className="manage-name">{kind.title}</p>
        <CustomEditor shape={kind.shape} pack={pack} defaultName={kind.title.replace(/…$/, "")} onSave={add} onCancel={cancel} />
      </div>
    );
  }
  return (
    <div className="add-check">
      <ul className="gallery" ref={galleryRef} aria-label="New rule">
        {RULE_KINDS.map((each) => (
          <li key={each.title}>
            <button type="button" className="gallery-item" aria-label={`Use ${each.title}`} onClick={() => setKind(each)}>
              <b>{each.title}</b>
              <span>{each.line}</span>
              <EvalBadge model />
            </button>
          </li>
        ))}
      </ul>
      <div className="row"><Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button></div>
    </div>
  );
}

// Long enough to read the note, short enough that an old one never describes a newer state.
const NOTE_MS = 5000;

type CheckManagerProps = { repo: string; pr: PrRef | undefined; onAddModel: () => void };

export function CheckManager({ repo, pr, onAddModel }: CheckManagerProps) {
  const packs = useStorageItem(localPacks);
  const settings = useStorageItem(systemOne);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(function forgetStatus() {
    if (!status) return;
    const timer = setTimeout(function clear() {
      setStatus(null);
    }, NOTE_MS);
    return function stop() {
      clearTimeout(timer);
    };
  }, [status]);

  if (packs === undefined || settings === undefined) return null;
  const stored = packs[repo];
  const read = stored === undefined ? { pack: recommendedPack(repo) } : readLocalPack(stored, repo);
  const scoring = pr?.repo === repo ? pr : undefined;

  function rescore() {
    if (scoring) send({ type: "triage", pr: scoring, mode: "refetch" });
  }

  // Built on the latest saved pack, so two quick changes never drop the first.
  async function save(change: (pack: CheckPack) => CheckPack, message: string): Promise<boolean> {
    setError(null);
    try {
      await saveLocalPack(change(await savedPackFor(repo)));
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
    setStatus(message);
    rescore();
    return true;
  }

  async function reset() {
    setError(null);
    try {
      await resetLocalPack(repo);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    setEditing(null);
    setStatus("Back to the default rules.");
    rescore();
  }

  if ("error" in read) {
    return (
      <div className="manager">
        <p className="error" role="alert">The rules saved for <span className="mono">{repo}</span> do not read ({read.error}).</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row"><ConfirmButton size="sm" variant="outline" confirmLabel="Confirm: reset every rule" onConfirm={reset}>Reset to defaults</ConfirmButton></div>
      </div>
    );
  }
  const { pack } = read;
  const changes = stored ? changesFromDefaults(pack) : 0;
  const rows = rowsOf(pack);
  const locked = (row: Row) => row.model && !settings;
  const on = rows.filter((row) => row.on && !locked(row)).length;

  return (
    <div className="manager">
      <div className="scope" data-changed={changes > 0}>
        <p><span className="mono repo-name">{repo}</span> {changes > 0 ? `· ${changes} ${changes === 1 ? "change" : "changes"}` : "· Defaults"}</p>
        {changes > 0 ? <ConfirmButton size="sm" variant="ghost" confirmLabel="Confirm: reset every rule" onConfirm={reset}>Reset to defaults</ConfirmButton> : null}
      </div>
      <div className="manager-status">
        <p className="saved-status" role="status">{status ? <><Check className="saved-mark" aria-hidden="true" />{status}</> : null}</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      <section className="part" aria-labelledby="checks">
        <h2 id="checks">Rules <span className="count mono">{on} on</span></h2>
        <p className="hint">The rules Triage applies to every pull request.</p>
        {settings ? null : <p className="hint">Rules marked Decision model need one. <button type="button" className="text-button" onClick={onAddModel}>Add a decision model</button></p>}
        <ul className="manage-list">
          {rows.map((row) => (
            <CheckRow key={row.id} row={row} pack={pack} editing={editing === row.id} onEdit={setEditing} onSave={save} locked={locked(row)} />
          ))}
        </ul>
        <AddCheck pack={pack} onSave={save} />
      </section>
    </div>
  );
}
