import type { FileNote } from "../view.ts";

const FILE_HEADER = ".file-header[data-path]";

function fileHeader(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${FILE_HEADER}[data-path="${CSS.escape(path)}"]`);
}

export function noteAnchor(path: string): Element | null {
  const header = fileHeader(path);
  return header?.querySelector(".file-info") ?? header;
}

export function onFilesTab(): boolean {
  return /\/pull\/\d+\/files\/?$/.test(location.pathname);
}

function lineRow(path: string, line: number): HTMLElement | null {
  const file = fileHeader(path)?.closest(".file");
  return file?.querySelector<HTMLElement>(`td.blob-num-addition[data-line-number="${line}"]`)?.closest("tr") ?? null;
}

/**
 * A line Triage found gets a thin orange edge in GitHub's gutter, so it is found while scrolling the diff; a line no
 * longer found, after a new run, loses it.
 */
export function markLines(notes: FileNote[]): void {
  const wanted = new Map<string, FileNote>(notes.flatMap((note): Array<[string, FileNote]> => (note.line === undefined ? [] : [[`${note.path}:${note.line}`, note]])));
  for (const row of document.querySelectorAll<HTMLElement>("tr[data-corbits-triage]")) {
    if (wanted.has(row.dataset.corbitsTriage!)) continue;
    delete row.dataset.corbitsTriage;
    row.style.removeProperty("box-shadow");
    row.removeAttribute("title");
  }
  for (const [at, note] of wanted) {
    const row = lineRow(note.path, note.line!);
    if (!row || row.dataset.corbitsTriage === at) continue;
    row.dataset.corbitsTriage = at;
    row.style.boxShadow = "inset 2px 0 0 #E98428";
    row.title = `Corbits Triage: ${note.check}. ${note.reason}`;
  }
}

export type FileMarker = { element: HTMLElement; render(path: string, notes: FileNote[]): void };

export function fileMarker(): FileMarker {
  const element = document.createElement("span");
  element.className = "file-note";

  function render(path: string, notes: FileNote[]) {
    const anchor = fileHeader(path)?.querySelector<HTMLAnchorElement>('a[href^="#diff-"]')?.getAttribute("href");
    const checks = [...new Set(notes.map((note) => note.check))];
    const label = document.createElement("b");
    label.textContent = `Triage: ${checks.join(", ")}`;
    const parts: Node[] = [label];
    const lines = notes.flatMap((note) => (note.line === undefined ? [] : [note.line]));
    if (lines.length) {
      parts.push(document.createTextNode(lines.length === 1 ? " line " : " lines "));
      lines.forEach(function lineLink(line, index) {
        if (index) parts.push(document.createTextNode(", "));
        const link = document.createElement(anchor ? "a" : "span");
        link.textContent = String(line);
        if (link instanceof HTMLAnchorElement) link.href = `${anchor}R${line}`;
        parts.push(link);
      });
    }
    element.title = notes.map((note) => `${note.check}: ${note.reason}`).join("\n");
    element.replaceChildren(...parts);
  }

  return { element, render };
}
