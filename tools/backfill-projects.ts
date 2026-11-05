// One-time: attach existing pages to the projects they name (True Nature, Frequency, Zero Proof, Elemental…).
// Reads each person's pages from disk, matches known project names in title/notes/summary/body, and
// rewrites the page through GBrain (never by editing the file directly) with a `project:` field.
import { join } from "node:path";
import * as gb from "../app/gbrain.ts";
import { loadCatalog } from "../app/librarian.ts";
import { scanPages, projectsOf, matchProject, invalidate } from "../app/projects.ts";
import { listPeople, whoIs } from "../app/identity.ts";

const apply = Bun.argv.includes("--apply");
const catalog = await loadCatalog();
const people = await listPeople();
for (const email of Object.keys(people.people)) {
  const person = await whoIs("127.0.0.1", email); if (!person) continue;
  invalidate(person.dir);
  for (const it of scanPages(person.dir)) {
    if (it.project || /^(gdocs|docs|tests)\//.test(it.id)) continue;
    const page = await gb.getPage(gb.scopeFor(person.source), it.id).catch(() => null); if (!page) continue;
    const content: string = page.content ?? page.markdown ?? "";
    const hay = [it.title, it.notes, it.summary, content.slice(0, 4000)].join("\n");
    let hit;
    for (const p of projectsOf(catalog)) {
      for (const name of [p.name, ...(p.aliases ?? [])]) {
        if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)) { hit = p; break; }
      }
      if (hit) break;
    }
    if (!hit) continue;
    console.log(`${apply ? "set" : "would set"} ${person.id}/${it.id} → ${hit.id}`);
    if (!apply) continue;
    const m = content.match(/^---\n([\s\S]*?)\n---\n?/); if (!m) continue;
    const fm = m[1].replace(/^project:.*\n?/m, "") + `\nproject: ${hit.id}`;
    await gb.putPage(gb.scopeFor(person.source), it.id, `---\n${fm}\n---\n${content.slice(m[0].length)}`);
    await gb.addTag(gb.scopeFor(person.source), it.id, `project:${hit.id}`).catch(() => {});
  }
}
