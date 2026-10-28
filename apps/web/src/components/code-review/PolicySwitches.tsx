import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, StatusDot, Switch } from "@corbits/react-ui";
import { fileRuleId, isCatalogId, ON_FAILS, onFailText, requiredField, type CatalogId, type CheckPack, type PolicyFileStatus, type PolicyPatchChange, type RepoSource } from "@corbits/triage-contracts";
import { addCatalogRule, codeReviewOn, flipCodeReview, flipRule, hasCustomRoom, judgeClaim, judgeRule, LANES, ruleRows, statusLine, withAdded, type Added, type FailWord, type Lane, type RuleRow } from "../../lib/policy-patch.ts";
import ChangeTray from "./ChangeTray.tsx";

/** What the workspace lacks for a lane, and the one place on this page that adds it. */
export type Missing = { words: string; action: string; href: string };

type PolicySwitchesProps = {
  repo: string;
  source: RepoSource;
  file: PolicyFileStatus;
  pack: CheckPack;
  reviewOn: boolean;
  hasModel: boolean;
  reviewMissing: Missing | undefined;
  /** The open pull request that changes the file, shown under the status line until it merges. */
  pull: ReactNode;
  /** The rows the open pull request changes from the default branch, which keep a dot until it merges. */
  pending: readonly string[];
  disabled: boolean;
};

const MODEL_MISSING: Missing = { words: "Needs a model", action: "Add a model", href: "#decision-model" };

/** Two answers make one claim, and a policy file's sentence holds at most 500 characters. */
const ANSWER_MAX = 240;

const FAIL_CHOICES: Record<FailWord, string> = { fail: "Fail the pull request", ask: "Ask a maintainer", label: "Label it and leave the verdict" };

function MissingLine({ missing }: { missing: Missing }) {
  return <p className="help" role="status">{missing.words}. <a href={missing.href}>{missing.action}</a></p>;
}

function willSentence(on: boolean): string {
  return on ? "Triage runs this on each pull request once the pull request with this change merges." : "Triage stops running this once the pull request with this change merges.";
}

function maxOf(draft: string): number | undefined {
  return /^[1-9]\d*$/.test(draft.trim()) ? Number(draft.trim()) : undefined;
}

function pathsOf(draft: string): string[] {
  return draft.split(/[,\n]/).map((path) => path.trim()).filter((path) => path.length > 0);
}

const NEEDED_ASK: Record<"max" | "paths", string> = { max: "Up to how many?", paths: "Which paths, separated by commas?" };

/** A built-in rule the file lacks is added with the reason a person gives, and its limit or paths when it has one. */
function AddRule({ id, disabled, onAdd, onCancel }: { id: CatalogId; disabled: boolean; onAdd: (added: Added) => void; onCancel: () => void }) {
  const needed = requiredField(id);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const valueId = useId();
  const reasonId = useId();

  function added(): Added | undefined {
    const why = reason.trim();
    if (!why) return undefined;
    if (needed === "max") {
      const max = maxOf(value);
      return max === undefined ? undefined : { reason: why, max };
    }
    if (needed === "paths") {
      const paths = pathsOf(value);
      return paths.length === 0 ? undefined : { reason: why, paths };
    }
    return { reason: why };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const ready = added();
    if (ready) onAdd(ready);
  }

  return (
    <form className="ask" onSubmit={submit}>
      {needed ? <label htmlFor={valueId}>{NEEDED_ASK[needed]}</label> : null}
      {needed ? <Input id={valueId} value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)} /> : null}
      <label htmlFor={reasonId}>Why does this repository need it?</label>
      <Input id={reasonId} value={reason} maxLength={ANSWER_MAX * 2} disabled={disabled} onChange={(event) => setReason(event.target.value)} />
      <div className="acts">
        <Button type="submit" size="sm" disabled={disabled || added() === undefined}>Add to the changes</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** A rule's sentence, and on a second line what its failure does when that is not failing the pull request. */
function RuleText({ sentence, onFail }: { sentence: string; onFail: string | undefined }) {
  return <>{sentence}{onFail ? <span className="on-fail">{onFail}</span> : null}</>;
}

type RowProps = { sentence: string; onFail?: string; on: boolean; pending: boolean; disabled: boolean; onFlip: (on: boolean) => void; children: ReactNode };

function SwitchRow({ sentence, onFail, on, pending, disabled, onFlip, children }: RowProps) {
  return (
    <div className={on ? "rule" : "rule off"}>
      <div className="sentence">
        <span className="txt"><RuleText sentence={sentence} onFail={onFail} />{pending ? <StatusDot className="pending" label="In the open pull request" tone="warning" /> : null}</span>
        <Switch className="sw" checked={on} onCheckedChange={onFlip} label={sentence} disabled={disabled} />
      </div>
      {children}
    </div>
  );
}

/** Three questions, in order, each rewriting the sentence the file receives. */
function JudgeRuleForm({ pack, changes, disabled, onAdd }: { pack: CheckPack; changes: readonly PolicyPatchChange[]; disabled: boolean; onAdd: (change: PolicyPatchChange) => void }) {
  const [step, setStep] = useState(0);
  const [subject, setSubject] = useState("");
  const [passes, setPasses] = useState("");
  const [onFail, setOnFail] = useState<FailWord>("fail");
  const subjectId = useId();
  const passesId = useId();
  const failId = useId();
  const claim = judgeClaim(subject, passes);
  const change = claim ? judgeRule(pack, changes, claim, onFail) : undefined;
  const failWords = change?.kind === "add-rule" ? onFailText(withAdded(pack, [change]), fileRuleId(change.rule)) : undefined;
  const answered = [subject, passes].map((answer) => answer.trim().length > 0);

  if (!hasCustomRoom(pack, changes)) return <p className="help">This repository has as many custom rules as a policy file holds.</p>;

  function next(event: FormEvent) {
    event.preventDefault();
    if (step < 2) {
      if (answered[step]) setStep(step + 1);
      return;
    }
    if (change) onAdd(change);
    setStep(0);
    setSubject("");
    setPasses("");
    setOnFail("fail");
  }

  return (
    <form className="judge-form" onSubmit={next}>
      {claim ? <p className="preview"><RuleText sentence={claim} onFail={step === 2 ? failWords : undefined} /></p> : null}
      <div className="ask">
        <label htmlFor={subjectId}>What should Triage check?</label>
        <Input id={subjectId} value={subject} maxLength={ANSWER_MAX} disabled={disabled} onChange={(event) => setSubject(event.target.value)} />
      </div>
      {step >= 1 ? (
        <div className="ask">
          <label htmlFor={passesId}>When does it pass?</label>
          <Input id={passesId} value={passes} maxLength={ANSWER_MAX} disabled={disabled} autoFocus onChange={(event) => setPasses(event.target.value)} />
        </div>
      ) : null}
      {step === 2 ? (
        <div className="ask">
          <span id={failId}>What happens on fail?</span>
          <div className="segmented" role="radiogroup" aria-labelledby={failId}>
            {ON_FAILS.map((word) => <button key={word} type="button" role="radio" aria-checked={onFail === word} disabled={disabled} onClick={() => setOnFail(word)}>{FAIL_CHOICES[word]}</button>)}
          </div>
        </div>
      ) : null}
      <div className="acts">
        <Button type="submit" size="sm" disabled={disabled || !answered.slice(0, step + 1).every(Boolean)}>{step < 2 ? "Next" : "Add the rule"}</Button>
      </div>
    </form>
  );
}

/** The file's rules as switches under Checks, Judging and Code review; changes collect in the tray and leave as one pull request. */
export default function PolicySwitches({ repo, source, file, pack, reviewOn, hasModel, reviewMissing, pull, pending, disabled }: PolicySwitchesProps) {
  const [changes, setChanges] = useState<PolicyPatchChange[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState<CatalogId | null>(null);
  const rows = ruleRows(pack, changes, hasModel);
  const review = codeReviewOn(reviewOn, changes);

  function flip(row: RuleRow, on: boolean) {
    setExpanded(row.id);
    if (on && !row.listed && isCatalogId(row.id)) {
      setAdding(row.id);
      return;
    }
    setAdding(null);
    setChanges((current) => flipRule(pack, current, row.id, on));
  }

  function added(id: CatalogId, rule: Added) {
    setChanges((current) => addCatalogRule(current, id, rule));
    setAdding(null);
  }

  function rowBody(row: RuleRow): ReactNode {
    const { id } = row;
    if (adding === id && isCatalogId(id)) return <AddRule id={id} disabled={disabled} onAdd={(rule) => added(id, rule)} onCancel={() => setAdding(null)} />;
    if (row.on && row.needsModel) return <MissingLine missing={MODEL_MISSING} />;
    return expanded === id ? <p className="help">{willSentence(row.on)}</p> : null;
  }

  function reviewBody(): ReactNode {
    if (review && reviewMissing) return <MissingLine missing={reviewMissing} />;
    return expanded === "code-review" ? <p className="help">{willSentence(review)}</p> : null;
  }

  function lane(key: Lane) {
    return (
      <section key={key} className="rs" aria-labelledby={`lane-${key}`}>
        <h3 id={`lane-${key}`}>{LANES[key]}</h3>
        <div className="sentences">
          {rows[key].map((row) => (
            <SwitchRow key={row.id} sentence={row.sentence} onFail={row.onFail} on={row.on || adding === row.id} pending={pending.includes(row.id)} disabled={disabled} onFlip={(on) => flip(row, on)}>
              {rowBody(row)}
            </SwitchRow>
          ))}
        </div>
        {key === "judging" ? <JudgeRuleForm pack={pack} changes={changes} disabled={disabled} onAdd={(change) => setChanges((current) => [...current, change])} /> : null}
      </section>
    );
  }

  function opened() {
    setChanges([]);
    setExpanded(null);
  }

  function flipReview(on: boolean) {
    setExpanded("code-review");
    setChanges((current) => flipCodeReview(reviewOn, current, on));
  }

  return (
    <>
      <p className="lede">{statusLine(rows, review)}</p>
      {pull}
      {lane("checks")}
      {lane("judging")}
      <section className="rs" aria-labelledby="lane-code-review">
        <h3 id="lane-code-review">Code review</h3>
        <div className="sentences">
          <SwitchRow sentence="Read each pull request for bugs" on={review} pending={pending.includes("code-review")} disabled={disabled} onFlip={flipReview}>
            {reviewBody()}
          </SwitchRow>
        </div>
      </section>
      {changes.length > 0 ? <ChangeTray repo={repo} source={source} file={file} pack={pack} changes={changes} disabled={disabled} onOpened={opened} /> : null}
    </>
  );
}
