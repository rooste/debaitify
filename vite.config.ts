import { defineConfig } from "vitest/config";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: "esnext", sourcemap: true },
  test: {
    // jsdom throughout: the extraction and selector tests need a DOM, and the
    // pure-function tests do not care.
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
