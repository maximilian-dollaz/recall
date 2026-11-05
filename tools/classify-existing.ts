// Propose a category and tags for every Google Docs page in the library. Read-only: writes a CSV, changes no page.
// Usage: bun classify-existing.ts [--out <csv>] [--sample N] [page.md ...]
//   --out     CSV path (default: imports/librarian-proposals.csv, gitignored)
//   --sample  classify N random pages and print a table instead of the whole set
//   page.md   classify only these pages (paths relative to library/gdocs) and print a table

import { Glob } from "bun";
import { join, relative, resolve } from "path";
import { classify } from "./librarian";

const root = resolve(import.meta.dir, "..");
const gdocs = join(root, "library/gdocs");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const outPath = resolve(arg("--out") ?? join(root, "imports/librarian-proposals.csv"));
const sample = arg("--sample") ? Number(arg("--sample")) : 0;
const picked = process.argv.slice(2).filter((a, i, all) => a.endsWith(".md") && !["--out", "--sample"].includes(all[i - 1]));
const table = sample > 0 || picked.length > 0;

function splitFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
  }
  return { meta, body: md.slice(m[0].length) };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

let files = picked.length ? picked : [...new Glob("**/*.md").scanSync(gdocs)].sort();
if (sample > 0) {
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  files = files.slice(0, sample);
}

const rows: string[][] = [];
let failed = 0;
for (const [n, rel] of files.entries()) {
  const path = join(gdocs, rel);
  const { meta, body } = splitFrontmatter(await Bun.file(path).text());
  const title = meta.title || rel.replace(/\.md$/, "");
  process.stderr.write(`[${n + 1}/${files.length}] ${rel}\n`);
  try {
    const r = await classify({ title, text: body, filename: meta.source_file || rel });
    rows.push([relative(root, path), meta.type ?? "", r.category, r.type, r.tags.join(" "), r.summary]);
  } catch (e) {
    failed++;
    rows.push([relative(root, path), meta.type ?? "", "ERROR", "", "", String(e instanceof Error ? e.message : e)]);
  }
}

if (table) {
  for (const [file, , category, , tags, summary] of rows) {
    console.log(`${file.replace("library/gdocs/", "")}\t${category}\t${tags}\t${summary}`);
  }
} else {
  const header = ["file", "current_type", "category", "type", "tags", "summary"];
  await Bun.write(outPath, [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${outPath}${failed ? ` (${failed} failed)` : ""}`);
}
