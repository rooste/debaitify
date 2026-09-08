/**
 * Refuse to commit anything credential-shaped.
 *
 * This repository is public and the extension is bring-your-own-key, so a
 * stray key file in the working tree is a live hazard — one already appeared
 * once (key.secret, unignored, 109 bytes) and was only missed by timing.
 *
 * .gitignore is the first line of defence; this is the second, because a
 * .gitignore only helps for the shapes you predicted.
 *
 * Run over staged content by default (`--staged`, used by the pre-commit hook),
 * or over everything tracked with no arguments.
 */
import { execFileSync } from "node:child_process";

const CONTENT_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sk-[A-Za-z0-9]{32,}/, "OpenAI-style API key"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub personal access token"],
  [/github_pat_[A-Za-z0-9_]{50,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "private key"],
];

/** Files whose *name* alone is disqualifying, whatever they contain. */
const NAME_PATTERN =
  /(^|\/)(\.env(\..+)?|.*\.(secret|key|pem|p12|keystore|token)|key\..*|.*api-?key.*)$/i;

const ALLOW = [/^tests\/fixtures\//, /^scripts\/check-secrets\.mjs$/];

const staged = process.argv.includes("--staged");
const files = execFileSync(
  "git",
  staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACM"] : ["ls-files"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !ALLOW.some((a) => a.test(f)));

const findings = [];

for (const file of files) {
  if (NAME_PATTERN.test(file)) {
    findings.push({ file, line: 0, what: "file name looks like a credential" });
    continue;
  }
  let content;
  try {
    content = execFileSync("git", ["show", staged ? `:${file}` : `HEAD:${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    continue; // binary, deleted, or not yet in the index
  }
  content.split("\n").forEach((text, i) => {
    for (const [re, what] of CONTENT_PATTERNS) {
      if (re.test(text)) findings.push({ file, line: i + 1, what });
    }
  });
}

if (findings.length > 0) {
  console.error("\n✗ Refusing to proceed — possible secrets:\n");
  // Never print the matched text: this output may end up in a log or a paste.
  for (const f of findings) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ""} — ${f.what}`);
  }
  console.error(
    "\nKeys belong in secrets/ (gitignored) or in the extension's own storage.\n" +
      "If this is a false positive, add an entry to ALLOW in scripts/check-secrets.mjs.\n",
  );
  process.exit(1);
}

console.log(`✓ no secrets found in ${files.length} ${staged ? "staged" : "tracked"} files`);
