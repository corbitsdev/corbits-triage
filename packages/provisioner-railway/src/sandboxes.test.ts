import { expect, test } from "bun:test";
import { connectRailwaySandboxes, RailwayCreateRefused } from "./sandboxes.js";

type ListVariables = { readonly after: string | null };

test("list() follows Railway's pages to the last one", async () => {
  const requests: ListVariables[] = [];
  async function railway(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { variables } = JSON.parse(String(init?.body)) as { variables: ListVariables };
    requests.push(variables);
    const second = variables.after === "c1";
    const node = { id: second ? "sbx_page2" : "sbx_page1", status: "RUNNING" };
    const pageInfo = { hasNextPage: !second, endCursor: second ? null : "c1" };
    return Response.json({ data: { sandboxes: { edges: [{ node }], pageInfo } } });
  }
  const sandboxes = connectRailwaySandboxes({ token: "t", environmentId: "env", fetch: railway as typeof fetch }, []);
  expect((await sandboxes.list()).map((sandbox) => sandbox.id)).toEqual(["sbx_page1", "sbx_page2"]);
  expect(requests.map((variables) => variables.after)).toEqual([null, "c1"]);
});

/** What creating a sandbox raises when Railway answers `status` with `body`. */
async function createAnswered(status: number, body: unknown): Promise<unknown> {
  async function railway(_url: string | URL | Request, _init?: RequestInit): Promise<Response> {
    return Response.json(body, { status });
  }
  const sandboxes = connectRailwaySandboxes({ token: "t", environmentId: "env", fetch: railway as typeof fetch }, []);
  try {
    await sandboxes.create({});
  } catch (error) {
    return error;
  }
  throw new Error("create succeeded");
}

test("only a clear refusal of a new sandbox is final", async () => {
  expect(await createAnswered(200, { errors: [{ message: "Not Authorized" }] })).toBeInstanceOf(RailwayCreateRefused);
  expect(await createAnswered(400, { errors: [{ message: "Invalid input" }] })).toBeInstanceOf(RailwayCreateRefused);
  for (const passing of [
    await createAnswered(429, { errors: [{ message: "Rate limited" }] }),
    await createAnswered(503, { errors: [{ message: "Service unavailable" }] }),  ]) {
    expect(passing).toBeInstanceOf(Error);
    expect(passing).not.toBeInstanceOf(RailwayCreateRefused);
  }
});
