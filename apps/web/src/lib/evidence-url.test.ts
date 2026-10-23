import { expect, test } from "bun:test";
import { evidenceUrl } from "./evidence-url.ts";

const citation = { path: "src/a.ts", added: { start: 3, end: 3 } };

test("evidence links to the pull request's own host, and to nothing when the Bitbucket address is unknown", () => {
  expect(evidenceUrl({ source: "github", baseUrl: undefined, repo: "o/r", sha: "abc", citation })).toBe("https://github.com/o/r/blob/abc/src/a.ts?plain=1#L3");
  expect(evidenceUrl({ source: "bitbucket-datacenter", baseUrl: "https://bb.example/", repo: "PROJ/repo", sha: "abc", citation })).toBe("https://bb.example/projects/PROJ/repos/repo/browse/src/a.ts?at=abc");
  expect(evidenceUrl({ source: "bitbucket-datacenter", baseUrl: undefined, repo: "PROJ/repo", sha: "abc", citation })).toBeUndefined();
});
