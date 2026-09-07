/**
 * Post-build guard: every emitted script must actually parse.
 *
 * Exists because CRXJS appended its IIFE closer after a //# sourceMappingURL
 * comment — "//" comments to end of line, so the closer was swallowed and the
 * MAIN-world bridge died with "Unexpected end of input" before running a single
 * statement. The extension loaded, reported nothing on the extensions page, and
 * the bridge was simply absent. A syntax check is cheap; finding that by hand
 * was not.
 *
 * Each file is parsed twice — once as an ES module, once as a classic script —
 * because the build emits both. A file only fails if neither parse succeeds.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})("dist");

const tmp = mkdtempSync(join(tmpdir(), "debaitify-check-"));
const parses = (src, ext) => {
  const f = join(tmp, `probe.${ext}`);
  writeFileSync(f, src);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    return null;
  } catch (err) {
    return String(err.stderr ?? err.message).split("\n").find((l) => l.includes("Error")) ?? "parse failed";
  }
};

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const asModule = parses(src, "mjs");
  if (asModule === null) continue;
  const asScript = parses(src, "cjs");
  if (asScript === null) continue;

  failed++;
  console.error(`\n✗ ${f}`);
  console.error(`  as module: ${asModule}`);
  console.error(`  as script: ${asScript}`);
  console.error(`  ends with: …${src.slice(-140).replace(/\n/g, "\\n")}`);
}
rmSync(tmp, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} bundles failed to parse.`);
  process.exit(1);
}
console.log(`✓ all ${files.length} bundles parse`);
