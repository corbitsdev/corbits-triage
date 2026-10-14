export type DiffFile = { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string };

const FILE_START = "diff --git ";

/** A path as git writes it in a header: bare, or quoted with C escapes when it holds unusual characters. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const text = path.slice(1, -1);
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(text.slice(at + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      at += 3;
      continue;
    }
    const escaped = text[++at]!;
    bytes.push(({ n: 10, t: 9, '"': 34, "\\": 92 } as Record<string, number>)[escaped] ?? escaped.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string): string {
  return unquote(path).replace(/^[ab]\//, "");
}

function parseFile(lines: string[]): DiffFile {
  const header = lines[0]!.slice(FILE_START.length);
  // Without --- / +++ lines (a rename or mode change alone), the paths come from the header's two halves.
  const halves = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(header);
  let from = halves ? stripPrefix(halves[1]!) : "";
  let to = halves ? stripPrefix(halves[2]!) : "";
  let status = "modified";
  let hunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (hunk < 0) hunk = lines.length;
  for (const line of lines.slice(1, hunk)) {
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "removed";
    else if (line.startsWith("rename from ")) from = unquote(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) {
      to = unquote(line.slice("rename to ".length));
      status = "renamed";
    } else if (line.startsWith("copy to ")) status = "copied";
    else if (line.startsWith("--- ") && line !== "--- /dev/null") from = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") to = stripPrefix(line.slice(4));
    else if (line.startsWith("new mode") && status === "modified" && hunk === lines.length) status = "changed";
  }
  const body = lines.slice(hunk);
  let additions = 0;
  let deletions = 0;
  for (const line of body) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const file: DiffFile = { filename: status === "removed" ? from : to, status, additions, deletions };
  if (status === "renamed" || status === "copied") file.previous_filename = from;
  if (body.length) file.patch = body.join("\n");
  return file;
}

export function parseDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: DiffFile[] = [];
  let start = -1;
  lines.forEach(function split(line, index) {
    if (!line.startsWith(FILE_START)) return;
    if (start >= 0) files.push(parseFile(lines.slice(start, index)));
    start = index;
  });
  if (start >= 0) files.push(parseFile(lines.slice(start)));
  return files;
}
