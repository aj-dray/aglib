import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

/**
 * Built to `dist/` as self-contained static files the service serves itself,
 * so every asset is referenced relative to the page rather than from the root.
 */
const API = { "/api": { target: "http://localhost:3000", changeOrigin: true } };

export default defineConfig({
  base: "./",
  // assistant-ui's stylesheet is a Tailwind v4 artifact whose every measurement
  // reads `--spacing`, `--text-sm`, `--radius-3xl`. Those live in an `@theme`
  // block that only Tailwind's compiler turns into real custom properties —
  // imported as plain CSS the browser drops it, and with it every rule that
  // referenced it. Which is why the library appeared not to work at all.
  plugins: [tailwind(), react()],
  build: { outDir: "dist", emptyOutDir: true },
  // Dev and preview only. In production the service serves this bundle and the
  // API from one origin, and nothing is proxied.
  server: { proxy: API },
  preview: { proxy: API },
});
