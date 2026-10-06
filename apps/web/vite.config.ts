import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === "serve"
      ? [{
          name: "corbits-dev-csp",
          transformIndexHtml(html: string) {
            return html.replaceAll(PRODUCTION_CSP, DEVELOPMENT_CSP);
          },
        }]
      : []),
  ],
  preview: {
    headers: securityHeaders(),
  },
  server: {
    headers: securityHeaders(DEVELOPMENT_CSP),
    fs: { allow: [".."] },
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", function forwardHubOrigin(proxyReq) {
            proxyReq.setHeader("origin", "http://localhost:3000");
          });
        },
      },
    },
  },
}));

const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; frame-ancestors 'none'; base-uri 'self'";
const DEVELOPMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:3000 https: ws: wss:; form-action https://github.com; frame-ancestors 'none'; base-uri 'self'";

function securityHeaders(csp = PRODUCTION_CSP): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
  };
}
