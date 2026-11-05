// Flag documents that look like they contain passwords, API keys or card numbers.
// Usage: bun scan-secrets.ts <folder> ...   (reads docx/md/txt; prints file + what matched, never the value)
import mammoth from "mammoth";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const patterns: [string, RegExp][] = [
  ["api key (sk-/pk-)", /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["bearer/JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["password field", /\b(password|passwd|pwd|pin)\s*[:=]\s*\S{4,}/i],
  ["card number", /\b(?:\d[ -]?){13,16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

async function text(f: string) {
  if (f.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(await Bun.file(f).arrayBuffer()) });
    return value;
  }
  return await Bun.file(f).text();
}
function walk(p: string, out: string[]) {
  for (const n of readdirSync(p)) {
    if (n.startsWith(".")) continue;
    const q = join(p, n);
    if (statSync(q).isDirectory()) walk(q, out);
    else if (/\.(docx|md|txt)$/i.test(n)) out.push(q);
  }
}
const files: string[] = [];
for (const p of process.argv.slice(2)) walk(p, files);
let flagged = 0;
for (const f of files) {
  const t = await text(f);
  const hits = patterns.filter(([, re]) => re.test(t)).map(([n]) => n);
  if (hits.length) { flagged++; console.log(`${f.split("/").slice(-2).join("/")}: ${hits.join(", ")}`); }
}
console.log(`\n${flagged} of ${files.length} files flagged`);
