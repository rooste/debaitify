import { defineConfig } from "vitest/config";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "esnext",
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
