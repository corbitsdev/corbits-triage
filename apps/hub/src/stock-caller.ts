/** Stock routes read the caller's session from the same credentials the portal sent. */
export function asCaller(req: Request, method: string, path: string, body?: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["cookie", "authorization", "origin"]) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(new URL(path, req.url).toString(), { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
