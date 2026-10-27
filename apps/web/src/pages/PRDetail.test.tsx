import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PullHistory } from "./PRDetail.tsx";

const WHEN = "2026-10-26T12:00:00.000Z";

test("commits come before conversation, and each section names itself when empty", () => {
  const html = renderToStaticMarkup(
    <PullHistory host="GitHub" pending={false} error={null} commits={[]} comments={[]} />,
  );
  const commitsAt = html.indexOf(">Commits<");
  const conversationAt = html.indexOf(">Conversation<");
  expect(commitsAt).toBeGreaterThan(-1);
  expect(conversationAt).toBeGreaterThan(commitsAt);
  expect(html).toContain("No commits.");
  expect(html).toContain("No comments yet.");
  expect(html).not.toContain("Talk");
});

test("a commit shows its short id and first line, and a comment shows its author and text", () => {
  const html = renderToStaticMarkup(
    <PullHistory
      host="GitHub"
      pending={false}
      error={null}
      commits={[{ sha: "abcdef1234567890", message: "fix: retry payouts\n\nBody stays off the row.", author: "ada", committedAt: WHEN }]}
      comments={[{ id: 7, author: "grace", body: "Looks good", createdAt: WHEN }]}
    />,
  );
  expect(html.indexOf(">Commits<")).toBeLessThan(html.indexOf(">Conversation<"));
  expect(html).toContain("abcdef1");
  expect(html).toContain("fix: retry payouts");
  expect(html).not.toContain("Body stays off the row.");
  expect(html).toContain("ada");
  expect(html).toContain("grace");
  expect(html).toContain("Looks good");
  expect(html).not.toContain("No commits.");
  expect(html).not.toContain("No comments yet.");
});

test("loading replaces both lists, and a failed load says so", () => {
  const loading = renderToStaticMarkup(
    <PullHistory host="Bitbucket" pending error={null} commits={[]} comments={[]} />,
  );
  expect(loading).toContain("Loading from Bitbucket…");
  expect(loading).not.toContain("No commits.");
  const failed = renderToStaticMarkup(
    <PullHistory host="GitHub" pending={false} error={new Error("offline")} commits={[]} comments={[]} />,
  );
  expect(failed).toContain("Could not load from GitHub.");
  expect(failed).toContain("offline");
});
