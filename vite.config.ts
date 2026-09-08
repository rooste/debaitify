import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

/** "chrome" (default) or "safari". The manifest is the only build-time fork. */
const target = process.env["DEBAITIFY_TARGET"] ?? "chrome";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: target === "safari" ? "dist-safari" : "dist",
    target: "esnext",
    rollupOptions: {
      // The bridge is injected by URL at runtime, so its filename must be
      // predictable — it cannot carry a content hash like the other chunks.
      input: { bridge: resolve(__dirname, "src/content/bridge-main.ts") },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "bridge" ? "bridge.js" : "assets/[name]-[hash].js",
      },
    },
    // "hidden" emits the .map files but NOT the //# sourceMappingURL comment.
    // With the comment present, CRXJS appends its IIFE closer after it on the
    // same line — "//" comments to end of line, so the closer is swallowed and
    // the MAIN-world bridge dies with "Unexpected end of input" before running.
    sourcemap: "hidden",
  },
  test: {
    // jsdom throughout: the extraction and selector tests need a DOM, and the
    // pure-function tests do not care.
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
