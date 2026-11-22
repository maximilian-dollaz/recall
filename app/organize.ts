// Sorting many meetings at once. A meeting the librarian can't place in a project waits here
// (<person>/unsorted-meetings.json) instead of asking "Which project?" one meeting at a time. Once a few have
// gathered and nothing is waiting to be filed, the librarian groups them: meetings about the same business,
// place, client, event or initiative become one Clarify question for the whole group, either "these belong in
// <a project you have>" or "these look like one new project: <name>". One tap answers for all of them.
// A meeting that fits no group is left alone after two looks.

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import * as store from "./store.ts";
import * as cues from "./cues.ts";
import * as projects from "./projects.ts";
import { chat, type Catalog } from "./librarian.ts";

export type Loose = { id: string; title: string; summary: string; tags: string[]; tries?: number };
const file = (dir: string) => join(dir, "unsorted-meetings.json");
const read = (dir: string): Loose[] => { try { return store.read<Loose[]>(file(dir), []); } catch { return []; } };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A filed meeting with no project: wait to be grouped. */
export async function note(dir: string, item: Loose) {
  await store.update<Loose[]>(file(dir), [], (l) => { if (!l.some((x) => x.id === item.id)) l.push(item); });
}
/** Items placed some other way (by hand, or a group answer) stop waiting. */
export async function drop(dir: string, ids: string[]) {
  if (!read(dir).some((x) => ids.includes(x.id))) return;
  await store.update<Loose[]>(file(dir), [], (l) => l.filter((x) => !ids.includes(x.id)));
}
export const waiting = (dir: string) => read(dir).filter((x) => (x.tries ?? 0) < 2).length;
const busy = (dir: string) => existsSync(join(dir, "inbox")) && readdirSync(join(dir, "inbox")).some((f) => f.endsWith(".json"));

/** Group this person's waiting meetings into Clarify questions. Returns how many questions it asked. */
export async function organize(dir: string, catalog: Catalog): Promise<number> {
  if (busy(dir)) return 0; // still filing: wait until the whole batch is in, so groups are as full as they can be
  const batch = read(dir).filter((x) => (x.tries ?? 0) < 2).slice(0, 60);
  if (batch.length < 3) return 0;
  const known = projects.projectsOf(catalog).map((p) => `- ${p.id}: ${[p.name, ...(p.aliases ?? [])].join(" / ")}`).join("\n");
  const lines = batch.map((x) => `- ${x.id} | ${x.title} | ${x.summary.slice(0, 220)} | ${x.tags.slice(0, 6).join(", ")}`).join("\n");
  const raw = await chat([{ role: "user", content: `These are meetings from one person's library that are not in a project yet. Group the ones that belong to the same project.

A project is a business, a physical space, a client, an event or an initiative the person is working on (for example a lounge, a product launch, a client account, a retreat). Not a project: a person's name alone, a kind of meeting ("weekly sync", "1:1", "standup"), a generic topic ("marketing", "ideas").

Known projects (id: names):
${known || "(none)"}

Meetings (id | title | summary | tags):
${lines}

Rules:
- Put a meeting in a group only when its title or summary clearly points to that project. Leave everything else out.
- Use a known project when the meetings are about it: set "existing" to its id.
- Otherwise name the new project the way the meetings name it, 1 to 4 words, Title Case.
- A new project needs at least 2 meetings. A known project can take 1.
- A meeting goes in one group at most.

Reply with JSON only: {"groups": [{"name": "<project name>", "existing": "<known project id or null>", "items": ["<meeting id>", ...], "why": "<one short line: what these meetings share>"}]}` }], { json: true });
  let groups: { name?: string; existing?: string | null; items?: string[]; why?: string }[] = [];
  try { groups = JSON.parse(raw).groups ?? []; } catch { groups = []; }
  const ids = new Set(batch.map((x) => x.id)), placed = new Set<string>();
  let asked = 0;
  for (const g of groups) {
    const items = [...new Set((g.items ?? []).filter((i) => ids.has(i) && !placed.has(i)))];
    const existing = (g.existing && projects.projectsOf(catalog).find((p) => p.id === g.existing)) || (g.name ? projects.matchProject(catalog, g.name) : undefined);
    const name = (g.name ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!items.length || (!existing && (items.length < 2 || !name || projects.generic(name)))) continue;
    const titles = items.map((i) => batch.find((x) => x.id === i)!.title);
    for (const i of items) {
      placed.add(i);
      if (existing) await cues.group(dir, `move:${existing.id}`, i, (n) => ({ title: existing.name, snippet: [g.why, titles.slice(0, 3).join(" · ")].filter(Boolean).join(" — "),
        question: `${n} meeting${n === 1 ? "" : "s"} look like ${n === 1 ? "it belongs" : "they belong"} in ${existing.name}. Move ${n === 1 ? "it" : "them"} there?`,
        options: [{ id: `to:${existing.id}`, label: `Move to ${existing.name}` }, { id: "leave", label: "Leave as is" }] }));
      else await cues.group(dir, `make:${slug(name)}`, i, (n) => ({ title: name, snippet: [g.why, titles.slice(0, 3).join(" · ")].filter(Boolean).join(" — "),
        question: `${n} meetings look like one project: "${name}". Make it a project?`,
        options: [{ id: `new:${name}`, label: `Make "${name}"` }, { id: "leave", label: "Leave as is" }] }));
    }
    asked++;
  }
  // Grouped meetings stop waiting; the rest get one more look when new meetings arrive.
  await store.update<Loose[]>(file(dir), [], (l) => l.filter((x) => !placed.has(x.id)).map((x) => (ids.has(x.id) ? { ...x, tries: (x.tries ?? 0) + 1 } : x)));
  if (asked) console.log(`[organize] ${dir.split("/").pop()}: ${asked} project question${asked === 1 ? "" : "s"} from ${placed.size} meetings`);
  return asked;
}
