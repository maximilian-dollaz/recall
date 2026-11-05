// Move every save from one person's library into another's (e.g. a second Google account's saves into the
// person's main library). Files are copied first, each page is written into the main library with its file paths
// rewritten, and only then removed from the old one. The old pages are kept under <old>/moved/ as a backup.
// bun tools/merge-library.ts <from-dir> <from-source> [--run]   (without --run it only lists)

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, cpSync } from "node:fs";
import { join } from "node:path";
import * as gb from "../app/gbrain.ts";
import * as store from "../app/store.ts";
import { DATA as ROOT } from "../app/paths.ts";

const [fromRel, fromSource] = Bun.argv.slice(2);
const RUN = Bun.argv.includes("--run");
if (!fromRel || !fromSource) { console.error("usage: bun tools/merge-library.ts <from-dir> <from-source> [--run]"); process.exit(2); }
const FROM = join(ROOT, fromRel), TO = join(ROOT, "library");
const shelves = ["inspiration", "projects", "reference", "links", "people", "notes"];

const pages = shelves.flatMap((s) => existsSync(join(FROM, s)) ? readdirSync(join(FROM, s)).filter((f) => f.endsWith(".md")).map((f) => `${s}/${f.slice(0, -3)}`) : []);
console.log(`${pages.length} saves in ${fromRel}${RUN ? "" : " (listing only; add --run to move)"}`);
let moved = 0;
for (const slug of pages) {
  const md = readFileSync(join(FROM, `${slug}.md`), "utf8");
  const title = md.match(/^title:\s*(.+)$/m)?.[1] ?? slug;
  if (!RUN) { console.log(`  ${slug}  ${title}`); continue; }
  if (existsSync(join(TO, `${slug}.md`))) { console.log(`  skip (already in main): ${slug}`); continue; }
  // The files: libraries/max-3/files/<id>/… → library/files/<id>/…
  for (const id of new Set([...md.matchAll(new RegExp(`${fromRel}/files/([^/\\s]+)/`, "g"))].map((m) => m[1]))) {
    const src = join(FROM, "files", id), dst = join(TO, "files", id);
    if (existsSync(src) && !existsSync(dst)) cpSync(src, dst, { recursive: true });
  }
  const out = md.split(`${fromRel}/files/`).join("library/files/");
  await gb.putPage(gb.scopeFor("default"), slug, out);
  for (const t of [...(out.match(/^tags:\n((?:\s+- .+\n)+)/m)?.[1] ?? "").matchAll(/- (.+)/g)].map((m) => m[1].trim())) await gb.addTag(gb.scopeFor("default"), slug, t).catch(() => {});
  const proj = out.match(/^project:\s*(\S+)/m)?.[1]; if (proj) await gb.addTag(gb.scopeFor("default"), slug, `project:${proj}`).catch(() => {});
  await gb.deletePage(gb.scopeFor(fromSource), slug).catch((e) => console.log(`  (old copy stays in ${fromSource}: ${String(e).slice(0, 80)})`));
  const bak = join(FROM, "moved", slug); mkdirSync(join(bak, ".."), { recursive: true });
  if (existsSync(join(FROM, `${slug}.md`))) renameSync(join(FROM, `${slug}.md`), `${bak}.md`);
  console.log(`  moved: ${title}`); moved++;
}
// Their come-back reminders follow them.
if (RUN && existsSync(join(FROM, "reminders.json"))) {
  const theirs = store.read<any[]>(join(FROM, "reminders.json"), []);
  await store.update<any[]>(join(TO, "reminders.json"), [], (mine) => { for (const r of theirs) if (!mine.some((m) => m.id === r.id)) mine.push(r); });
  console.log(`  reminders merged: ${theirs.length}`);
}
if (RUN) console.log(`${moved} moved.`);
