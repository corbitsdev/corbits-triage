import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { contentSecurityPolicy, securityHeaders } from "./src/security-headers.ts";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: "corbits-meta-csp",
      transformIndexHtml() {
        const mode = command === "serve" ? "development" : "production";
        return [{
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy({ mode, meta: true }) },
          injectTo: "head-prepend" as const,
        }];
      },
    },
  ],
  preview: {
    headers: securityHeaders(),
  },
  server: {
    headers: securityHeaders("development"),
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
