import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEVELOPMENT_CSP, DEVELOPMENT_META_CSP, PRODUCTION_META_CSP, securityHeaders } from "./src/security-headers.ts";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === "serve"
      ? [{
          name: "corbits-dev-csp",
          transformIndexHtml(html: string) {
            return html.replaceAll(PRODUCTION_META_CSP, DEVELOPMENT_META_CSP);
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
