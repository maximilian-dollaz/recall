// Long saves in pieces. A long doc, meeting or voice note stays whole as one item; its pieces worth keeping
// (ideas, actions, decisions, realizations, reflections) are pulled out, each its own small page that is
// sorted into a project and links back to the exact spot in the whole. The librarian reads the whole text
// this way, a window at a time, instead of only its first 6000 characters.
//
// It runs behind the normal filing: the whole item is filed first, as always, and a pieces job waits in
// <person>/pieces/. One window is read per turn, and only while no new save is waiting, so a 100-page doc
// never holds up anyone's photo.

import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import * as gb from "./gbrain.ts";
import { chat, loadCatalog } from "./librarian.ts";
import * as projects from "./projects.ts";
import type { Person } from "./identity.ts";

export const LONG = 8000;     // characters; shorter saves are read whole by the librarian already
const WINDOW = 6000;          // what the small model reads at once, with room for the prompt (num_ctx 8192)
const PER_WINDOW = 4;         // pieces at most per window; none is fine
export const KINDS = ["idea", "action", "decision", "realization", "reflection"] as const;
type Kind = typeof KINDS[number];

export type Window = { start: number; end: number; section?: string };
export type Piece = { kind: Kind; title: string; quote: string; tags: string[]; at: number; section?: string };
type Job = { id: string; slug: string; title: string; notes: string; project?: string; who?: string; body: string; windows: Window[]; next: number; made: { slug: string; title: string; kind: Kind; q?: string }[]; created: string; fails?: number };

/** Windows of about WINDOW characters along paragraph breaks, each knowing the heading it sits under. */
export function split(body: string, size = WINDOW): Window[] {
  const paras: { start: number; end: number }[] = [];
  const re = /\n{2,}/g; let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(body))) { if (m.index > last) paras.push({ start: last, end: m.index }); last = m.index + m[0].length; }
  if (last < body.length) paras.push({ start: last, end: body.length });
  // A paragraph longer than a window (a transcript with no breaks) is cut at sentence ends, then hard.
  const parts: { start: number; end: number }[] = [];
  for (const p of paras) {
    if (p.end - p.start <= size) { parts.push(p); continue; }
    let s = p.start;
    while (p.end - s > size) {
      const slice = body.slice(s, s + size);
      const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "), slice.lastIndexOf("\n"));
      const e = cut > size / 2 ? s + cut + 1 : s + size;
      parts.push({ start: s, end: e }); s = e;
      while (s < p.end && /\s/.test(body[s])) s++;
    }
    if (s < p.end) parts.push({ start: s, end: p.end });
  }
  // The last heading above the window, or the window's own first line when that is a heading.
  const headingAt = (i: number) => { const eol = body.indexOf("\n", i); const h = [...body.slice(0, eol < 0 ? body.length : eol).matchAll(/^#{1,6} +(.+)$/gm)].pop(); return h?.[1]?.trim(); };
  const out: Window[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const p of parts) {
    // A heading starts a new window once the current one has some substance.
    const heading = /^#{1,6} /.test(body.slice(p.start, p.start + 7));
    if (cur && (p.end - cur.start > size || (heading && cur.end - cur.start > size / 4))) { out.push({ ...cur, section: headingAt(cur.start) }); cur = null; }
    cur = cur ? { start: cur.start, end: p.end } : { ...p };
  }
  if (cur) out.push({ ...cur, section: headingAt(cur.start) });
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"‘’'`*_>#]/g, "").replace(/\s+/g, " ").trim();

/** Where a quote sits in the text, or -1 when the model made it up. Small models drop a word or a comma,
 *  so a quote whose first or last 8 words are found word for word still counts. */
export function locate(text: string, quote: string): number {
  const t = norm(text), q = norm(quote);
  if (q.length < 12) return -1;
  let i = t.indexOf(q);
  if (i < 0) { const w = q.split(" "); if (w.length >= 10) { i = t.indexOf(w.slice(0, 8).join(" ")); if (i < 0) { const j = t.indexOf(w.slice(-8).join(" ")); if (j >= 0) i = Math.max(0, j - (q.length - w.slice(-8).join(" ").length)); } } }
  if (i < 0) return -1;
  // Map the position in the normalized text back to the original, by proportion (close enough to scroll to).
  return Math.round(i * (text.length / Math.max(1, t.length)));
}

/** The librarian reads one window and pulls out its pieces. Only pieces whose words are really in the text survive. */
export async function extract(job: Pick<Job, "title" | "notes" | "body">, w: Window, part: number, of: number): Promise<Piece[]> {
  const text = job.body.slice(w.start, w.end);
  const raw = await chat([{ role: "user", content: `You are reading part ${part} of ${of} of a long item the owner saved: "${job.title}".${w.section ? ` This part is under the heading "${w.section}".` : ""} The owner said about it: """${job.notes || "(nothing)"}"""

Pull out the pieces worth keeping on their own: ideas, actions (something someone needs to do), decisions, realizations, reflections. Skip greetings, small talk, filler, and anything that only makes sense with the rest of the text. At most ${PER_WINDOW} pieces; an empty list is fine.

For each piece:
- "kind": one of idea, action, decision, realization, reflection
- "title": a short specific title, max 8 words, naming what the piece is about
- "quote": the exact sentence or sentences from the text, copied word for word, max 60 words
- "tags": 2 to 5 short lowercase tags: people, places, named things, topics

Text:
"""${text}"""

Reply with JSON only: {"pieces": [{"kind": "...", "title": "...", "quote": "...", "tags": ["..."]}]}` }], { json: true });
  let parsed: any = {}; try { parsed = JSON.parse(raw); } catch {}
  const list: any[] = Array.isArray(parsed?.pieces) ? parsed.pieces : [];
  const out: Piece[] = [];
  for (const p of list.slice(0, PER_WINDOW)) {
    const quote = String(p?.quote ?? "").trim(); const title = String(p?.title ?? "").trim();
    if (!quote || !title) continue;
    if (quote.split(/\s+/).length < 9) continue; // small talk ("hold on, my dog is barking") is never a piece
    const at = locate(text, quote); if (at < 0) continue;
    const kind = (KINDS as readonly string[]).includes(p.kind) ? p.kind as Kind : "idea";
    const tags = Array.isArray(p.tags) ? p.tags.map((t: unknown) => String(t).toLowerCase().trim().replace(/\s+/g, "-")).filter(Boolean).slice(0, 5) : [];
    if (out.some((o) => norm(o.quote) === norm(quote))) continue;
    out.push({ kind, title: title.slice(0, 80), quote: quote.slice(0, 600), tags, at: w.start + at, section: w.section });
  }
  return out;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "piece";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dirOf = (p: Person) => { const d = join(p.dir, "pieces"); mkdirSync(d, { recursive: true }); return d; };

/** After a long item is filed: queue its pieces. Returns false when it's too short to need them. */
export async function queue(person: Person, it: { id: string; slug: string; title: string; notes: string; project?: string; who?: string; body: string }): Promise<boolean> {
  if (it.body.length < LONG) return false;
  const job: Job = { ...it, windows: split(it.body), next: 0, made: [], created: new Date().toISOString() };
  await Bun.write(join(dirOf(person), `${it.id}.json`), JSON.stringify(job));
  console.log(`[pieces] ${person.id}: ${it.slug} queued, ${job.windows.length} parts`);
  return true;
}

function pieceMarkdown(job: Job, p: Piece, project: string | undefined): string {
  const fm = [
    "---",
    `title: ${JSON.stringify(p.title)}`,
    "type: note",
    `shelf: ${p.kind === "action" || p.kind === "decision" ? "projects" : "inspiration"}`,
    project ? `project: ${project}` : null,
    "kind: note",
    `piece_kind: ${p.kind}`,
    `piece_of: ${job.slug}`,
    `piece_at: ${p.at}`,
    "state: idea",
    `tags: [${[p.kind, ...p.tags].map((t) => JSON.stringify(t)).join(", ")}]`,
    `saved: ${today()}`,
    `saved_at: ${new Date().toISOString()}`,
    "saved_via: pieces",
    job.who ? `saved_by: ${JSON.stringify(job.who)}` : null,
    "---",
  ].filter(Boolean).join("\n");
  return [fm, "", `> ${p.kind[0].toUpperCase() + p.kind.slice(1)} from "${job.title}"${p.section ? `, under "${p.section}"` : ""}.`, "", "## The passage", "", p.quote, "", "## From", "", `[[${job.slug}|${job.title}]]`, ""].join("\n");
}

/** One window of one job, or, after the last one, the list of pieces on the whole item. */
async function step(person: Person, path: string, onDone: (p: Person) => void): Promise<void> {
  const job: Job = JSON.parse(readFileSync(path, "utf8"));
  const scope = gb.scopeFor(person.source);
  if (job.next < job.windows.length) {
    const w = job.windows[job.next];
    const found = await extract(job, w, job.next + 1, job.windows.length);
    const catalog = await loadCatalog();
    for (const p of found) {
      // The same point said twice, or one quote inside another, is one piece.
      const q = norm(p.quote);
      if (job.made.some((m) => m.q && (m.q.includes(q) || q.includes(m.q)))) continue;
      // A known project named in the piece itself wins; otherwise the piece belongs where the whole item went.
      const named = projects.namedIn(catalog, `${p.section ?? ""}\n${p.quote}`)[0];
      const project = named?.id ?? job.project;
      const shelf = p.kind === "action" || p.kind === "decision" ? "projects" : "inspiration";
      const slug = `${shelf}/${today()}-${slugify(p.title)}-${job.id.slice(-6)}-${job.made.length + 1}`;
      await gb.putPage(scope, slug, pieceMarkdown(job, p, project));
      await gb.addTag(scope, slug, "piece").catch(() => {});
      if (project) await gb.addTag(scope, slug, `project:${project}`).catch(() => {});
      job.made.push({ slug, title: p.title, kind: p.kind, q });
    }
    job.next++;
    await Bun.write(path, JSON.stringify(job));
    if (found.length) onDone(person);
    return;
  }
  // Every part read: the whole item lists its pieces, so each one is a click away from the other.
  if (job.made.length) {
    const page = await gb.getPage(scope, job.slug).catch(() => null);
    const content: string = page?.content ?? page?.markdown ?? "";
    if (content) {
      const list = job.made.map((m) => `- ${m.kind[0].toUpperCase() + m.kind.slice(1)}: [[${m.slug}|${m.title}]]`).join("\n");
      const without = content.replace(/\n## Pieces\n[\s\S]*?(?=\n## |\s*$)/, "");
      await gb.putPage(scope, job.slug, `${without.trimEnd()}\n\n## Pieces\n\n${list}\n`);
    }
  }
  unlinkSync(path);
  console.log(`[pieces] ${person.id}: ${job.slug} done, ${job.made.length} pieces from ${job.windows.length} parts`);
  onDone(person);
}

/** The pieces worker: one window at a time, only while nobody's new save is waiting. */
export function start(hooks: { busy: () => boolean; people: () => Promise<Person[]>; onDone: (p: Person) => void }) {
  let running = false;
  const tick = async () => {
    if (running || hooks.busy()) return; running = true;
    try {
      for (const person of await hooks.people()) {
        const d = join(person.dir, "pieces"); if (!existsSync(d)) continue;
        const next = readdirSync(d).filter((n) => n.endsWith(".json")).sort()[0]; if (!next) continue;
        const path = join(d, next);
        try { await step(person, path, hooks.onDone); }
        catch (e) {
          // A service that is down or busy is not the window's fault: try again later. Anything else three times, then skip that window.
          if (/ECONNREFUSED|fetch failed|Unable to connect|pglite_busy|timed? ?out|aborted/i.test(String(e))) { console.error(`[pieces waiting] ${person.id}/${next}: ${String(e).slice(0, 160)}`); return; }
          try { const job: Job = JSON.parse(readFileSync(path, "utf8")); job.fails = (job.fails ?? 0) + 1; if (job.fails >= 3) { job.next++; job.fails = 0; } await Bun.write(path, JSON.stringify(job)); }
          catch { unlinkSync(path); }
          console.error(`[pieces failed] ${person.id}/${next}: ${String(e).slice(0, 200)}`);
        }
        return; // one window per tick, so new saves get the librarian back quickly
      }
    } finally { running = false; }
  };
  setInterval(() => tick().catch(() => {}), 5_000);
}

/** For the item page: the whole item a piece came from, and the passage to show there. */
export function origin(frontmatter: string): { of: string; at: number } | undefined {
  const of = frontmatter.match(/^piece_of: *(.+)$/m)?.[1]?.trim(); if (!of) return undefined;
  return { of, at: Number(frontmatter.match(/^piece_at: *(\d+)$/m)?.[1] ?? 0) };
}
