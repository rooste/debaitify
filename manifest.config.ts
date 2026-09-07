/**
 * NOTE: the two entry points must not share a basename. When both were
 * `index.ts`, the bundler emitted colliding chunk names and the service-worker
 * loader ended up importing the CONTENT SCRIPT chunk — the extension loaded
 * without error and did nothing at all.
 *
 * The manifest is GENERATED from src/sites/sites.json so that the hosts the
 * extension asks permission for can never drift from the hosts it is configured
 * to act on. Adding a site is a JSON edit plus a rebuild.
 */
import type { ManifestV3Export } from "@crxjs/vite-plugin";
import sites from "./src/sites/sites.json" with { type: "json" };

const hostGlobs = sites.sites
  .filter((s) => s.enabled)
  .flatMap((s) => s.hosts.map((h) => `https://${h}/*`));

export default {
  manifest_version: 3,
  name: "Debaitify",
  version: "0.1.0",
  description:
    "Replaces clickbait headlines with accurate ones generated from the article.",
  permissions: ["storage"],
  host_permissions: ["https://api.anthropic.com/*", ...hostGlobs],
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  content_scripts: [
    {
      matches: hostGlobs,
      js: ["src/content/content-script.ts"],
      css: ["src/styles/antiflash.css"],
      run_at: "document_start",
      all_frames: false,
    },
    {
      // Runs in the PAGE's world, which is the only way to read the hydration
      // state holding each teaser's lead sentence. It reads and postMessages;
      // it never touches page state and holds no credentials.
      matches: hostGlobs,
      js: ["src/content/bridge-main.ts"],
      run_at: "document_idle",
      world: "MAIN",
      all_frames: false,
    },
  ],
  options_ui: { page: "src/options/index.html", open_in_tab: true },
  action: { default_popup: "src/popup/index.html" },
} satisfies ManifestV3Export;
