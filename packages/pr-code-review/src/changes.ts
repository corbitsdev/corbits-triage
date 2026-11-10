/** Compare exact snapshots rather than a merge base, so rebases and force-pushes still compare the two reviewed heads. */
export async function changesBetween(directory: string, before: string, after: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(before) || !/^[0-9a-f]{40}$/.test(after)) throw new Error("review comparison requires pinned commits");
  if (before === after) return "";
  const run = Bun.spawn(["git", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--", before, after], {
    cwd: directory,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [text, error, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (exit !== 0 && exit !== 1) throw new Error(`review comparison failed (${exit}): ${error}`);
  // Only strip the leading snapshot directory, never matching strings inside filenames or code.
  function repositoryPath(path: string): string {
    return path.replace(/^("?[ab]\/)[0-9a-f]{40}\//, "$1");
  }
  let inHunk = false;
  return text.split("\n").map(function normalizeLine(line) {
    if (line.startsWith("@@ ")) inHunk = true;
    if (!line.startsWith("diff --git ")) {
      if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) return line.slice(0, 4) + repositoryPath(line.slice(4));
      return line;
    }
    inHunk = false;
    const paths = line.slice("diff --git ".length);
    // No renames: both paths have the same filename and equally long SHA prefixes, even when quoted.
    const middle = (paths.length - 1) / 2;
    if (!Number.isInteger(middle) || paths[middle] !== " ") throw new Error("review comparison has unequal snapshot paths");
    return `diff --git ${repositoryPath(paths.slice(0, middle))} ${repositoryPath(paths.slice(middle + 1))}`;
  }).join("\n");
}
