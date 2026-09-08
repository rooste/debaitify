/**
 * Copy the Safari build into the Xcode project's extension Resources.
 *
 * The Xcode project is committed but Resources/ is not — it is generated from
 * dist-safari/, and committing it would duplicate build output and guarantee
 * drift. Run this after `npm run build:safari`, or let the Xcode "Run Script"
 * build phase call it so Cmd-R always ships current code.
 */
import { existsSync, rmSync, cpSync, mkdirSync } from "node:fs";

const SRC = "dist-safari";
const DEST = "safari/Debaitify/Shared (Extension)/Resources";

if (!existsSync(SRC)) {
  console.error(`✗ ${SRC}/ not found — run \`npm run build:safari\` first.`);
  process.exit(1);
}

if (!existsSync("safari/Debaitify")) {
  console.log(
    `• safari/Debaitify/ does not exist yet — build output is in ${SRC}/.\n` +
      `  Create the Xcode project with:\n` +
      `    xcrun safari-web-extension-converter ${SRC} \\\n` +
      `      --project-location safari --app-name Debaitify --bundle-identifier fi.rooste.debaitify`,
  );
  process.exit(0);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
console.log(`✓ synced ${SRC}/ → ${DEST}/`);
