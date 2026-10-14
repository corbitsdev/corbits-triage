import { useMemo, useState } from "react";
import { Button } from "@corbits/react-ui";
import { missingPatchReason, parsePatch, splitRows, type DiffHunk, type DiffLine, type PatchedFile } from "../lib/diff.ts";
import type { DiffLayout } from "../lib/diff-layout.ts";

export type DiffFile = PatchedFile & { path: string; previousPath?: string };

const COLLAPSE_AFTER_LINES = 500;
const LAYOUTS: Array<{ id: DiffLayout; label: string }> = [
  { id: "stacked", label: "Stacked" },
  { id: "split", label: "Split" },
];
const MARK: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "" };
const SPOKEN: Record<DiffLine["kind"], string> = { add: "added: ", del: "removed: ", ctx: "" };

function LineText({ line }: { line: DiffLine }) {
  return (
    <>
      {SPOKEN[line.kind] ? <span className="sr-only">{SPOKEN[line.kind]}</span> : null}
      {line.text}
      {line.noNewline ? <span className="diff-eof" title="No newline at end of file" role="img" aria-label="No newline at end of file">⊘</span> : null}
    </>
  );
}

function StackedLine({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="ln old">{line.oldNo}</span>
      <span className="ln new">{line.newNo}</span>
      <span className="gutter" aria-hidden="true">{MARK[line.kind]}</span>
      <span className="code"><LineText line={line} /></span>
    </div>
  );
}

function SplitSide({ line, side }: { line: DiffLine | null; side: "old" | "new" }) {
  if (!line) return <><span className="ln" /><span className="gutter" /><span className="code empty" /></>;
  return (
    <>
      <span className={`ln ${line.kind}`}>{side === "old" ? line.oldNo : line.newNo}</span>
      <span className={`gutter ${line.kind}`} aria-hidden="true">{MARK[line.kind]}</span>
      <span className={`code ${line.kind}`}><LineText line={line} /></span>
    </>
  );
}

function Hunk({ hunk, layout }: { hunk: DiffHunk; layout: DiffLayout }) {
  const rows = useMemo(() => (layout === "split" ? splitRows(hunk.lines) : []), [hunk, layout]);
  return (
    <div>
      <div className="diff-hunk-head"><span className="diff-hunk-meta">{hunk.header}</span></div>
      {layout === "stacked"
        ? hunk.lines.map((line, index) => <StackedLine key={index} line={line} />)
        : rows.map((row, index) => (
            <div className="diff-split-row" key={index}>
              <SplitSide line={row.left} side="old" />
              <SplitSide line={row.right} side="new" />
            </div>
          ))}
    </div>
  );
}

function readHunks(patch: string): DiffHunk[] | null {
  try {
    return parsePatch(patch);
  } catch (cause) {
    console.warn("Could not parse a diff patch.", cause);
    return null;
  }
}

function DiffBody({ file, layout }: { file: DiffFile; layout: DiffLayout }) {
  const [expanded, setExpanded] = useState(false);
  const { patch } = file;
  const hunks = useMemo(() => (patch ? readHunks(patch) : null), [patch]);
  if (!patch) return <div className="diff-note"><p>{missingPatchReason(file)}</p></div>;
  if (!hunks) return <div className="diff-note"><p>Could not read this diff.</p></div>;
  const lineCount = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (lineCount > COLLAPSE_AFTER_LINES && !expanded) {
    return (
      <div className="diff-note">
        <p>Large diff collapsed.</p>
        <Button type="button" variant="outline" onClick={() => setExpanded(true)}>Expand {lineCount} lines</Button>
      </div>
    );
  }
  return <>{hunks.map((hunk, index) => <Hunk key={index} hunk={hunk} layout={layout} />)}</>;
}

export function DiffView({ file, layout, canSplit, onLayout }: {
  file: DiffFile;
  layout: DiffLayout;
  canSplit: boolean;
  onLayout: (layout: DiffLayout) => void;
}) {
  const shown = canSplit ? layout : "stacked";
  return (
    <article className="diff-viewer">
      <header className="diff-chrome">
        <h2 className="diff-path">
          {file.previousPath ? <><span className="diff-old-path">{file.previousPath}</span> → </> : null}
          {file.path}
        </h2>
        <div className="diff-tools">
          <p className="diff-stat">
            <span className="add">+{file.additions}</span>{" "}
            <span className="del">−{file.deletions}</span>
          </p>
          {canSplit ? (
            <div className="segmented diff-layout" role="radiogroup" aria-label="Diff layout">
              {LAYOUTS.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={option.id === layout} onClick={() => onLayout(option.id)}>{option.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      </header>
      <div className={`diff-body ${shown}`} role="region" aria-label="Diff">
        <DiffBody key={file.path} file={file} layout={shown} />
      </div>
    </article>
  );
}
