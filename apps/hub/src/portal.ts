import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { securityHeaders } from "../../web/src/security-headers.js";

const HUB_PATHS = ["/api/", "/status", "/openapi.json"];

export function isPortalRequest(req: Request): boolean {
  const { pathname } = new URL(req.url);
  return (req.method === "GET" || req.method === "HEAD") && !HUB_PATHS.some((path) => pathname.startsWith(path));
}

/** Serves the built portal, answering client-side routes with index.html. */
export function createPortalHandler(dir: string): (req: Request) => Promise<Response> {
  const root = resolve(dir);
  const indexPath = resolve(root, "index.html");
  if (!existsSync(indexPath)) throw new Error(`PORTAL_DIR has no index.html: ${root}`);

  function filePath(pathname: string): string {
    try {
      const target = resolve(root, `.${decodeURIComponent(pathname)}`);
      return target.startsWith(root + sep) ? target : indexPath;
    } catch {
      return indexPath;
    }
  }

  return async function servePortal(req: Request) {
    const target = filePath(new URL(req.url).pathname);
    const file = Bun.file(target);
    const body = target !== indexPath && (await file.exists()) ? file : Bun.file(indexPath);
    return new Response(body, { headers: securityHeaders() });
  };
}

/**
 * Lets exactly one portal origin call the API with credentials. Any other
 * origin gets no CORS headers, so the browser keeps its responses private.
 */
export function withPortalCors<Rest extends unknown[]>(
  portalOrigin: string,
  next: (req: Request, ...rest: Rest) => Promise<Response>,
): (req: Request, ...rest: Rest) => Promise<Response> {
  const allow = {
    "Access-Control-Allow-Origin": portalOrigin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };

  return async function corsRequest(req: Request, ...rest: Rest) {
    if (req.headers.get("origin") !== portalOrigin) return next(req, ...rest);
    if (req.method === "OPTIONS") {
      const requested = req.headers.get("access-control-request-headers");
      return new Response(null, {
        status: 204,
        headers: {
          ...allow,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
          ...(requested !== null && { "Access-Control-Allow-Headers": requested }),
          "Access-Control-Max-Age": "600",
        },
      });
    }
    const response = await next(req, ...rest);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(allow)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
