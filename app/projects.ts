// Projects: the businesses, spaces and initiatives a person's items are FOR.
// Nobody creates them by hand. The first time a sentence names one ("this is for Elemental"),
// the librarian creates it; every later mention attaches to it. Find can then open a project
// and show every asset for it: photos, voice notes, notes, links, documents.

import { join } from "node:path";
import { reconcile } from "./topics.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { updateCatalog, type Catalog } from "./librarian.ts";

export type Project = { id: string; name: string; aliases?: string[]; team?: boolean };
export type ProjectItem = { id: string; title: string; kind: string; thumb?: string; summary: string; saved: string; project?: string; url?: string; files: string[]; notes?: string; by?: string; tags: string[]; batch?: string; placed?: string; saved_at?: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(the|a|an|our|my)\b/g, " ").replace(/\s+/g, " ").trim();

export function projectsOf(catalog: Catalog): Project[] { return ((catalog as any).projects ?? []) as Project[]; }

// Words that name a kind of place or thing, not a project: "the lounge" alone is no project.
const GENERIC = new Set(["lounge", "bar", "space", "project", "projects", "media", "room", "studio", "shop", "board", "wall", "design", "inspiration", "mood"]);
export const generic = (n: string) => norm(n.replace(/[-_]+/g, " ")).split(" ").every((w) => !w || GENERIC.has(w));

/** Find the known project a name refers to: "the Elemental lounge" → Elemental. Never on a generic word alone. */
export function matchProject(catalog: Catalog, name: string): Project | undefined {
  const n = norm(name.replace(/[-_]+/g, " ")); if (n.length < 3 || generic(n)) return undefined;
  for (const p of projectsOf(catalog)) {
    for (const cand of [p.name, ...(p.aliases ?? [])]) {
      const c = norm(cand.replace(/[-_]+/g, " ")); if (!c) continue;
      if (c === n || c.replace(/ /g, "") === n.replace(/ /g, "")) return p;
      if (c.length >= 4 && (n.includes(c) || (c.includes(n) && n.length >= 4))) return p;
    }
  }
  return undefined;
}

/** Every known project named anywhere in what someone said, first-mentioned first. Forgiving of how dictation
 *  writes it ("zero-proof", "zeroproof", "Zero Proof's"), never on a generic word ("the lounge"). */
export function namedIn(catalog: Catalog, said: string): Project[] {
  const t = ` ${norm(said.replace(/[-_]+/g, " ").replace(/['’]s\b/g, ""))} `;
  const hits: { p: Project; at: number }[] = [];
  for (const p of projectsOf(catalog)) {
    const keys = new Set<string>();
    for (const cand of [p.name, ...(p.aliases ?? [])]) {
      const c = norm(cand.replace(/[-_]+/g, " ")); if (c.length < 4 || generic(c)) continue;
      keys.add(c); if (c.includes(" ")) keys.add(c.replace(/ /g, ""));
      // "zero proof lounge" → "zero proof". A one-word core counts only if it's distinctive: "back wall" must not
      // turn every sentence with "back" into that project.
      const core = c.split(" ").filter((w) => !GENERIC.has(w)).join(" ");
      if (core !== c && (core.includes(" ") ? core.length >= 4 : core.length >= 7)) keys.add(core);
    }
    let at = -1;
    for (const k of keys) { const i = t.indexOf(` ${k} `); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at >= 0) hits.push({ p, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.p);
}

/** The project for a name the librarian returned, creating it when it is new. */
export async function resolveProject(catalog: Catalog, name: string | undefined): Promise<Project | undefined> {
  if (!name) return undefined;
  const clean = name.replace(/^(the|for|at)\s+/i, "").trim().slice(0, 60); if (clean.length < 2) return undefined;
  const found = matchProject(catalog, clean) ?? projectsOf(catalog).find((x) => x.id === slugify(clean)); if (found) return found;
  // Made inside the catalog lock on a fresh read: a project made meanwhile (another save, another person) is kept,
  // and if it's this same one, it's reused instead of made twice.
  const p = await updateCatalog((fresh) => {
    const again = matchProject(fresh, clean) ?? projectsOf(fresh).find((x) => x.id === slugify(clean));
    if (again) return again;
    const made: Project = { id: slugify(clean), name: clean.replace(/\b\w/g, (c) => c.toUpperCase()), aliases: [] };
    (fresh as any).projects = [...projectsOf(fresh), made];
    return made;
  });
  // Keep the caller's copy in step, so the rest of this save sees the project.
  if (!projectsOf(catalog).some((x) => x.id === p.id)) (catalog as any).projects = [...projectsOf(catalog), p];
  return p;
}

// ── Pages on disk ────────────────────────────────────────────────────────────
// Each person's library is a folder of markdown pages (GBrain keeps them in sync). Reading the
// folder is far cheaper than asking the database page by page, and it is what the projects view needs.
const SKIP = new Set(["files", "vault", "inbox", "inbox-failed", ".thumbs", ".trash", "node_modules", ".git", "tests"]);
const IMG = /\.(png|jpe?g|gif|webp|heic|bmp)$/i, AUD = /\.(caf|m4a|mp3|wav|aac|ogg|opus|aiff)$/i, VID = /\.(mp4|mov|m4v|webm|mkv)$/i;

function kindOf(fm: any, files: string[], url?: string): string {
  const k = String(fm.kind ?? "");
  // A picture saved from a web page (web-1.jpg…) is a picture; its page link stays with it. A page preview isn't.
  if (files.some((f) => /\/web-\d+\.\w+$/.test(f))) return "image";
  if (k && k !== "other") return k === "audio" ? "voice" : k;
  if (files.some((f) => IMG.test(f))) return "image";
  if (files.some((f) => AUD.test(f))) return "voice";
  if (files.some((f) => VID.test(f))) return "video";
  if (files.length) return "document";
  if (url) return "link";
  return "note";
}
const dateStr = (v: unknown) => { if (v instanceof Date) return v.toISOString().slice(0, 10); const m = String(v ?? "").match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : ""; };

function parsePage(path: string, slug: string): ProjectItem | null {
  const content = readFileSync(path, "utf8");
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/); if (!m) return null;
  let fm: any = {}; try { fm = Bun.YAML.parse(m[1]) ?? {}; } catch { return null; }
  const body = content.slice(m[0].length);
  const files = Array.isArray(fm.files) ? fm.files.map(String) : [];
  const notes = body.match(/## Why I saved this\n\n([\s\S]*?)(?:\n\n## |\n*$)/)?.[1]?.trim();
  return {
    id: slug, title: String(fm.title ?? slug), kind: kindOf(fm, files, fm.url), thumb: files.find((f) => IMG.test(f)),
    summary: body.match(/^> (.+)$/m)?.[1] ?? "", saved: dateStr(fm.saved) || dateStr(fm.created) || slug.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "",
    project: fm.project ? String(fm.project) : undefined, url: fm.url ? String(fm.url) : undefined, files, notes, by: fm.saved_by ? String(fm.saved_by) : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.map((t: unknown) => String(t).toLowerCase()) : [],
    batch: fm.batch ? String(fm.batch) : undefined, placed: fm.placed ? (fm.placed instanceof Date ? fm.placed.toISOString() : String(fm.placed)) : undefined,
    saved_at: fm.saved_at ? (fm.saved_at instanceof Date ? fm.saved_at.toISOString() : String(fm.saved_at)) : undefined,
  };
}

const scanCache = new Map<string, { at: number; items: ProjectItem[] }>();

/** Items whose page mentions the words ("buddha artwork"), for moving many at once. Every word if any page has them
 *  all, otherwise the most specific word alone. Pictures count by what the librarian saw in them, too. */
export const ITEM_SHELVES = /^(projects|inspiration|reference|links|people)\//; // saved items; never soul/, gdocs/, docs/, skills/, tests/
export function matchItems(dir: string, words: string[], kind?: string): ProjectItem[] {
  const pool = scanPages(dir).filter((it) => ITEM_SHELVES.test(it.id) && (!kind || it.kind === kind));
  const text = new Map(pool.map((it) => { let t = ""; try { t = readFileSync(join(dir, `${it.id}.md`), "utf8").toLowerCase(); } catch {} return [it.id, t]; }));
  const has = (it: ProjectItem, w: string) => { const t = text.get(it.id) ?? ""; return t.includes(w) || (w.endsWith("s") && t.includes(w.slice(0, -1))); };
  if (!words.length) return kind ? pool.filter((it) => !it.project) : []; // "move the pictures to X": the ones in no project yet
  const every = pool.filter((it) => words.every((w) => has(it, w)));
  if (every.length) return every;
  const rare = words.map((w) => ({ w, n: pool.filter((it) => has(it, w)).length })).filter((x) => x.n).sort((a, b) => a.n - b.n)[0];
  return rare ? pool.filter((it) => has(it, rare.w)) : [];
}
export function invalidate(dir: string) { scanCache.delete(dir); }
export function scanPages(dir: string): ProjectItem[] {
  const c = scanCache.get(dir); if (c && Date.now() - c.at < 20_000) return c.items;
  const items: ProjectItem[] = [];
  const walk = (d: string, rel: string) => {
    let names: string[] = []; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(d, n); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, rel ? `${rel}/${n}` : n);
      else if (n.endsWith(".md") && n !== "README.md") { const it = parsePage(p, `${rel ? rel + "/" : ""}${n.slice(0, -3)}`); if (it) items.push(it); }
    }
  };
  walk(dir, "");
  items.sort((a, b) => b.saved.localeCompare(a.saved) || b.id.localeCompare(a.id));
  scanCache.set(dir, { at: Date.now(), items });
  return items;
}

// ── Views ────────────────────────────────────────────────────────────────────
export function projectsFor(dir: string, catalog: Catalog) {
  type Row = { id: string; name: string; count: number; cover?: string; latest: string; first: string; thumbs: string[]; counts: Record<string, number> };
  const byId = new Map<string, Row>();
  const known = new Map(projectsOf(catalog).map((p) => [p.id, p]));
  // Newest first, where something placed by hand counts from when it was placed, so it leads its panel.
  const newest = (it: ProjectItem) => [it.placed, it.saved_at, it.saved].filter(Boolean).sort().pop() ?? "";
  for (const it of [...scanPages(dir)].sort((a, b) => newest(b).localeCompare(newest(a)))) {
    if (!it.project) continue;
    const row = byId.get(it.project) ?? { id: it.project, name: known.get(it.project)?.name ?? it.project, count: 0, latest: newest(it), first: it.saved, thumbs: [], counts: {} };
    row.count++; if (!row.cover && it.thumb) row.cover = it.thumb; if (it.saved && it.saved < row.first) row.first = it.saved;
    if (it.thumb && row.thumbs.length < 12) row.thumbs.push(it.thumb);
    row.counts[it.kind] = (row.counts[it.kind] ?? 0) + 1;
    byId.set(it.project, row);
  }
  // The project most recently added to comes first; ones untouched for a while drift to the end (Max, 3 Nov,
  // replacing the 31 Oct "positions never change").
  return [...byId.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name));
}

// Cell division, first version: a project's items group by the topic tags the librarian gave them.
// Under five items the project is one cell. Above that, the tag shared by the most items becomes a group,
// then the next, up to seven groups (about what the mind takes in at once); what's left is "Loose ends".
// The nightly librarian will later name and refine these groups.
const GENERIC_TAGS = new Set(["photo", "image", "picture", "screenshot", "video", "voice", "note", "notes", "document", "link", "test", "testing", "idea", "ideas", "inspiration", "project", "design", "concept"]);
export function topicGroups(p: Project, items: ProjectItem[]) {
  const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const own = new Set([p.id, ...p.name.toLowerCase().split(/\s+/), ...(p.aliases ?? []).map((a) => a.toLowerCase())]);
  const STOP = new Set(["with", "from", "for", "the", "and", "about", "this", "that", "notes", "note", "idea", "ideas", "inspiration", "concept", "test", "session", "random", "thought", "thoughts"]);
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(?<=[^s])s$/, ""));
  // Topic signals: the librarian's tags plus the words of the title (titles name the topic most plainly).
  const tagsOf = (it: ProjectItem) => [...new Set([...it.tags, ...words(it.title)])].filter((t) => t.length > 2 && !t.includes(":") && !own.has(t) && !p.id.includes(t) && !GENERIC_TAGS.has(t));
  if (items.length < 5) return [{ id: "all", name: "Everything", items: items.map((i) => i.id) }];
  let left = [...items];
  const groups: { id: string; name: string; items: string[] }[] = [];
  while (groups.length < 7 && left.length) {
    const count = new Map<string, number>();
    for (const it of left) for (const t of new Set(tagsOf(it))) count.set(t, (count.get(t) ?? 0) + 1);
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!best || best[1] < 2) break;
    const members = left.filter((it) => tagsOf(it).includes(best[0]));
    groups.push({ id: best[0], name: title(best[0]), items: members.map((i) => i.id) });
    left = left.filter((it) => !members.includes(it));
  }
  if (left.length) groups.push({ id: "loose", name: groups.length ? "Loose ends" : "Everything", items: left.map((i) => i.id) });
  return groups;
}

export async function projectView(dir: string, catalog: Catalog, id: string) {
  const p = projectsOf(catalog).find((x) => x.id === id) ?? { id, name: id, aliases: [] };
  const items = scanPages(dir).filter((it) => it.project === id);
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  // Living topics (meaning-based, they form, divide and fuse); the simple tag grouping if the local AI is down.
  let groups: any[];
  try { groups = await reconcile(dir, p, items); } catch (e) { console.error(`[topics] ${id}: ${(e as Error).message}`); groups = topicGroups(p, items); }
  return { project: p, items, counts, groups, pack: pack(p, items) };
}

/** Everything about a project as one piece of text: for pasting into Claude, or sending to a person. */
export function pack(p: Project, items: ProjectItem[]): string {
  const label: Record<string, string> = { image: "Photo", voice: "Voice note", video: "Video", link: "Link", document: "Document", note: "Note" };
  const lines = [`# ${p.name}`, "", `${items.length} saved item${items.length === 1 ? "" : "s"}.`, ""];
  for (const it of items) {
    lines.push(`## ${it.title}  (${label[it.kind] ?? it.kind}, ${it.saved}${it.by ? `, saved by ${it.by}` : ""})`);
    if (it.summary) lines.push(it.summary);
    if (it.notes) lines.push(`Why it was saved: ${it.notes.replace(/\s+/g, " ")}`);
    if (it.url) lines.push(it.url);
    for (const f of it.files) lines.push(`File: ${f}`);
    lines.push("");
  }
  return lines.join("\n");
}
