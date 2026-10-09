import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The Huddle server the dev server hands API calls to. */
const server = "http://127.0.0.1:7700";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built app works wherever the server mounts it.
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
        // The proxy holds an event stream's headers back until its first event; send them at once, so
        // the browser sees the stream open (and the app shows "Live") straight away.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _request, response) => {
            if (String(proxyRes.headers["content-type"] ?? "").startsWith("text/event-stream")) process.nextTick(() => response.flushHeaders());
          });
        },
      },
      "/hooks": { target: server, changeOrigin: true },
      "/a2a": { target: server, changeOrigin: true },
      "/.well-known": { target: server, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
