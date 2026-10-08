// The single source of the portal's policy: vite.config.ts injects the meta policy into index.html and sets the
// dev/preview headers, and the hub sends the header policy when it serves the built portal.

// sonner appends an empty <style> at import and then fills it with its stylesheet; each step is checked against style-src.
// These hashes pin sonner's exact CSS, so security-headers.test.ts and the exact sonner pin in package.json go together.
export const SONNER_STYLE_HASHES = [
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  "'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='",
];

export type CspMode = "production" | "development";

const INLINE_SOURCES: Record<CspMode, { script: string; style: string }> = {
  production: { script: "", style: ` ${SONNER_STYLE_HASHES.join(" ")}` },
  development: { script: " 'unsafe-inline'", style: " 'unsafe-inline'" },
};

export function contentSecurityPolicy({ mode, meta }: { mode: CspMode; meta: boolean }): string {
  const inline = INLINE_SOURCES[mode];
  const policy = `default-src 'self'; script-src 'self'${inline.script}; style-src 'self'${inline.style}; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; base-uri 'self'`;
  // Browsers ignore frame-ancestors in a <meta> policy and warn about it.
  return meta ? policy : `${policy}; frame-ancestors 'none'`;
}

export function securityHeaders(mode: CspMode = "production"): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": contentSecurityPolicy({ mode, meta: false }),
    "X-Content-Type-Options": "nosniff",
  };
}
