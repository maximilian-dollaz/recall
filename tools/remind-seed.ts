// Add sparks to a person's Remind ledger from a JSON file, checking every word is really in the source.
//   bun tools/remind-seed.ts <person-dir> <sparks.json>
// sparks.json: [{ words, title, kind, question?, when_then?, from: { slug, title, date }, file }]
// `file` is the saved meeting/voice note (relative to the person dir) the words must be found in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as remind from "../app/remind.ts";
import { locate } from "../app/pieces.ts";

const [dir, list] = process.argv.slice(2);
if (!dir || !list) { console.error("usage: bun tools/remind-seed.ts <person-dir> <sparks.json>"); process.exit(1); }
const rows = JSON.parse(readFileSync(list, "utf8"));
let bad = 0, added = 0, i = 0;
for (const r of rows) {
  const text = readFileSync(join(dir, r.file), "utf8");
  const missing = r.words.split(/\.{3}|…/).map((p: string) => p.trim()).filter((p: string) => p.length >= 12).filter((p: string) => locate(text, p) < 0);
  if (missing.length) { console.error(`✗ ${r.title}: not in the source: ${missing.join(" | ")}`); bad++; continue; }
  // Spread the first returns: three a day from tomorrow, in the order given.
  const first = new Date(Date.now() + (1 + Math.floor(i++ / 3)) * 864e5);
  const s = await remind.add(dir, { words: r.words, title: r.title, kind: r.kind, question: r.question, when_then: r.when_then, from: r.from }, first);
  if (s) { added++; console.log(`✓ ${r.title}`); } else console.log(`= ${r.title} (already there)`);
}
console.log(`${added} added, ${bad} refused`);
if (bad) process.exit(2);
