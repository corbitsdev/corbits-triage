// Shared by the Vite dev server and the hub when it serves the built portal.
export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; frame-ancestors 'none'; base-uri 'self'";
export const DEVELOPMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; frame-ancestors 'none'; base-uri 'self'";

export function securityHeaders(csp = PRODUCTION_CSP): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
  };
}
