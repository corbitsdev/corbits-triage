import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResolvedLine } from "./Pulse.tsx";

test("a resolved pull links only to its stored page, never a guessed github.com one", () => {
  const pull = { key: "PROJ/repo#2", repo: "PROJ/repo", number: 2, title: "Merged" };
  expect(renderToStaticMarkup(<ResolvedLine pull={{ ...pull, url: null }} />)).not.toContain("<a ");
  expect(renderToStaticMarkup(<ResolvedLine pull={{ ...pull, url: "https://bb.example/projects/PROJ/repos/repo/pull-requests/2" }} />)).toContain('href="https://bb.example/projects/PROJ/repos/repo/pull-requests/2"');
});
