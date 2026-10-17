import { expect, test } from "bun:test";
import { appGithubFetch } from "./portal-credential.js";

test("an App read asks for JSON unless it names its own media type, such as a pull request's diff", async () => {
  const accepted: Array<string | null> = [];
  async function appFetch(_input: string, init?: RequestInit) {
    accepted.push(new Headers(init?.headers).get("accept"));
    return new Response("");
  }
  const gh = appGithubFetch(appFetch, "https://api.github.test", "{}");
  await gh("/repos/acme/widgets/pulls/7");
  await gh("/repos/acme/widgets/pulls/7", { headers: { accept: "application/vnd.github.diff" } });
  expect(accepted).toEqual(["application/vnd.github+json", "application/vnd.github.diff"]);
});
