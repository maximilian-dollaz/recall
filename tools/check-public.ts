// Everything committed here is public. This check stops a commit that carries a secret, or a private word
// from this install's own list, before it leaves the machine.
//
//   bun tools/check-public.ts            the files staged for commit (the pre-commit hook runs this)
//   bun tools/check-public.ts --all      every tracked file (CI runs this)
//
// Private words: private/denylist.txt, one per line (teammates' names, emails, internal hostnames, IDs).
// It is gitignored, so the list itself never becomes public. Lines starting with # are notes.
// Prints the file, the line and what matched, never the matched value itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SECRETS: [string, RegExp][] = [
  ["API key (sk-/pk-/rk-)", /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Google OAuth secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{20,}/],
  ["Resend key", /\bre_[A-Za-z0-9]{20,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["token field", /["']?(token|secret|password|api_key|apiKey)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i],
  ["invite or save link with a code", /\/(team|join|k)\/[A-Za-z0-9_-]{20,}/],
];
const TEXT = /\.(ts|js|mjs|json|md|html|css|sh|py|txt|yml|yaml|toml|plist|swift|example)$|^[^.]+$/;

const all = Bun.argv.includes("--all");
const git = (args: string[]) => new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd: ROOT }).stdout);
const files = (all ? git(["ls-files", "--cached", "--others", "--exclude-standard"]) : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])).split("\n").filter(Boolean);
const deny = existsSync(join(ROOT, "private/denylist.txt"))
  ? readFileSync(join(ROOT, "private/denylist.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];
const denyRe = deny.map((w) => [w, new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i")] as const);

let found = 0;
for (const f of files) {
  if (/\.shortcut$/.test(f)) { console.log(`${f}  a signed shortcut (it carries an install's address; build it per install)`); found++; continue; }
  if (!TEXT.test(f) || f === "tools/check-public.ts") continue;
  // Staged content, not the working copy: that's what the commit will hold.
  const text = all ? (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "") : git(["show", `:${f}`]);
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of SECRETS) if (re.test(line)) { console.log(`${f}:${i + 1}  ${name}`); found++; }
    for (const [w, re] of denyRe) if (re.test(line)) { console.log(`${f}:${i + 1}  private word #${deny.indexOf(w) + 1} from private/denylist.txt`); found++; }
  });
}
if (found) {
  console.log(`\n${found} thing(s) that must not be public. Move secrets to .env, names to roles ("the CEO", "a teammate"), then commit again.`);
  process.exit(1);
}
console.log(`check-public: ${files.length} file(s) clean${deny.length ? "" : " (no private/denylist.txt, so secrets only)"}`);
