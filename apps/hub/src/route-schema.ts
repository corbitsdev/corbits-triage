import { type } from "arktype";
import { resolver, validator } from "hono-openapi";
import { failure } from "./github/portal-credential.js";

/** The hub's error envelope. */
export const Failure = type({ error: { code: "string", message: "string" } });

/** An OpenAPI JSON response described by an arktype schema. */
export function json(description: string, schema: Parameters<typeof resolver>[0]) {
  return { description, content: { "application/json": { schema: resolver(schema) } } };
}

export function refuseInvalid(result: { success: true } | { success: false; error: ReadonlyArray<{ message: string }> }) {
  if (!result.success) return failure(400, "invalid_request", result.error.map((issue) => issue.message).join("; "));
}

/** Validates and documents a JSON body, refusing an invalid one with 400 `invalid_request`. */
export function body<S extends Parameters<typeof validator>[1]>(schema: S) {
  return validator("json", schema, refuseInvalid);
}
