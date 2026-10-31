import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 7250, npm start) and Vite on VITE_PORT (default 7251). /api is proxied, so the browser only ever
// talks to one origin (same-origin writes). Ports stay inside 7250-7249.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 7250}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 7251, strictPort: true, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js", testTimeout: 30000 },
});
