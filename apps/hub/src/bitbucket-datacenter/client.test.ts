import { expect, test } from "bun:test";
import { bitbucketFetch, instanceBaseUrl, pagedValues } from "./client.js";

test("an instance URL keeps its context path and drops a trailing slash; anything carrying more is refused", () => {
  expect(instanceBaseUrl(" https://git.example/bitbucket/ ")).toBe("https://git.example/bitbucket");
  expect(instanceBaseUrl("https://user:pw@git.example")).toBeUndefined();
  expect(instanceBaseUrl("https://git.example/?a=1")).toBeUndefined();
  expect(instanceBaseUrl("ftp://git.example")).toBeUndefined();
});

test("pages follow nextPageStart with the bearer token until the last page", async () => {
  const seen: string[] = [];
  async function instance(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    const last = String(input).includes("start=2");
    return Response.json({ values: last ? ["c"] : ["a", "b"], isLastPage: last, ...(!last && { nextPageStart: 2 }) });
  }
  const bb = bitbucketFetch(instance as typeof fetch, "https://git.example", "tok");
  expect(await pagedValues(bb, "/rest/api/1.0/repos")).toEqual(["a", "b", "c"]);
  expect(seen).toEqual([
    "https://git.example/rest/api/1.0/repos?start=0&limit=100 Bearer tok",
    "https://git.example/rest/api/1.0/repos?start=2&limit=100 Bearer tok",
  ]);
});
