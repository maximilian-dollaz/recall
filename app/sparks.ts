// Sparks: the highest-inspiration passages from years of notes, pulled out in the writer's own words and
// brought back on Remind's widening rhythm (remind.ts). New saves are already read for sparks as they arrive
// (server.ts, sparksFrom). This is the slow pass over everything saved BEFORE Remind existed.
//
//   Pace     A few pages every half hour, oldest first, at most PAGES_A_DAY a day, and only while fewer than
//            WAITING_MAX found sparks are still waiting for their first return. The phone is never flooded: Remind
//            itself sends at most three a day.
//   What     Notes, documents and voice notes with real text. Never pictures, links, or the pieces cut from a
//            meeting (their meeting is read whole instead). The same check as new saves: every quoted word must
//            be in the page, or the spark is dropped.
//   Ledger   <dir>/sparks-scan.json: which pages have been read, so each is read once.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as store from "./store.ts";
import * as remind from "./remind.ts";
import { scanPages } from "./projects.ts";
import type { Person } from "./identity.ts";

export const PAGES_A_TICK = 3, PAGES_A_DAY = 24, WAITING_MAX = 9, MIN_CHARS = 500;
type Scan = { on: boolean; read: Record<string, string>; days: Record<string, number>; found: number };
const file = (dir: string) => join(dir, "sparks-scan.json");
const empty = (): Scan => ({ on: true, read: {}, days: {}, found: 0 });
export const state = (dir: string): Scan => { try { return { ...empty(), ...store.read<Scan>(file(dir), empty()) }; } catch { return empty(); } };
const change = (dir: string, fn: (s: Scan) => void) => store.update<Scan>(file(dir), empty(), (s) => { const x = { ...empty(), ...s }; fn(x); return x; });

const SKIP = /^(soul|skills|tests|docs)\//;
/** The pages worth reading for sparks, oldest first. */
export function candidates(dir: string) {
  return scanPages(dir).filter((it) => ["note", "document", "voice"].includes(it.kind) && !it.tags.includes("piece") && !SKIP.test(it.id))
    .sort((a, b) => (a.saved || "").localeCompare(b.saved || "") || a.id.localeCompare(b.id));
}
const bodyOf = (dir: string, slug: string) => { try { return readFileSync(join(dir, `${slug}.md`), "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""); } catch { return ""; } };

/** What the Remind tab shows about the slow pass. */
export function status(dir: string) {
  const s = state(dir), all = candidates(dir);
  return { on: s.on, read: all.filter((it) => s.read[it.id]).length, total: all.length, found: s.found };
}
export async function setOn(dir: string, on: boolean) { await change(dir, (s) => { s.on = on; }); return on; }

/** One pass for one person. `find` is remind.find with the model and the word check already bound. */
export async function tick(person: Person, find: (text: string, title: string) => Promise<any[]>, now = new Date()): Promise<number> {
  const dir = person.dir, s = state(dir); if (!s.on) return 0;
  const day = remind.localDay(now); if ((s.days[day] ?? 0) >= PAGES_A_DAY) return 0;
  const waiting = remind.ledger(dir).sparks.filter((x) => x.state === "on" && x.sent === 0).length; if (waiting >= WAITING_MAX) return 0;
  const next = candidates(dir).filter((it) => !s.read[it.id]).slice(0, Math.min(PAGES_A_TICK, PAGES_A_DAY - (s.days[day] ?? 0)));
  let added = 0;
  for (const it of next) {
    const text = bodyOf(dir, it.id);
    let found: any[] = [];
    if (text.length >= MIN_CHARS) { try { found = await find(text, it.title); } catch (e) { console.error(`[sparks] ${person.id}: ${it.id}: ${String(e).slice(0, 160)}`); continue; } } // a model error: try this page again later
    let here = 0;
    for (const f of found) { const made = await remind.add(dir, { ...f, from: { slug: it.id, title: it.title, date: (it.saved || day).slice(0, 10) } }); if (made) { here++; console.log(`[sparks] ${person.id}: "${made.title}" from ${it.id}`); } }
    added += here;
    await change(dir, (x) => { x.read[it.id] = day; x.days = { [day]: (x.days[day] ?? 0) + 1 }; x.found += here; });
  }
  return added;
}
