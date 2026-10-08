// Shared by the Vite dev server and the hub when it serves the built portal.

// sonner appends an empty <style> at import and then fills it with its stylesheet; each step is checked against style-src.
export const SONNER_STYLE_HASHES = [
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  "'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='",
];

function contentSecurityPolicy(scriptSrc: string, styleSrc: string): string {
  return `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; base-uri 'self'`;
}

// Browsers ignore frame-ancestors in a <meta> policy and warn about it, so index.html carries the policy without it.
export const PRODUCTION_META_CSP = contentSecurityPolicy("'self'", `'self' ${SONNER_STYLE_HASHES.join(" ")}`);
export const DEVELOPMENT_META_CSP = contentSecurityPolicy("'self' 'unsafe-inline'", "'self' 'unsafe-inline'");
export const PRODUCTION_CSP = `${PRODUCTION_META_CSP}; frame-ancestors 'none'`;
export const DEVELOPMENT_CSP = `${DEVELOPMENT_META_CSP}; frame-ancestors 'none'`;

export function securityHeaders(csp = PRODUCTION_CSP): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
  };
}
