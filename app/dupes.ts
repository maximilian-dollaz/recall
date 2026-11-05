// Duplicates: the same picture or the same link saved more than once (three Spider-Man saves of one pin).
//
// Each item gets a few fingerprints: the sha1 of every attached file, and its link written one standard way
// (a Pinterest pin by its pin id, a YouTube video by its video id, tracking bits dropped). Two items that
// share any fingerprint are copies. Hashes are cached by file size and modified time, in memory and in
// <person>/.hashes.json, so a library of ~500 pages only reads a file again when it changes.

import { join, isAbsolute, relative } from "node:path";
import { statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import * as store from "./store.ts";
import { scanPages, ITEM_SHELVES, type ProjectItem } from "./projects.ts";

const toAbs = (root: string, f: string) => (isAbsolute(f) ? f : join(root, f));

// ── When it was saved, to the second ─────────────────────────────────────────
// `saved` on a page is a date only, so same-day saves tie. `saved_at` (when the filer writes it) or GBrain's
// `ingested_at` (written once, when the page is first filed, and kept through later edits) break the tie.
// Read once per page and cached by its modified time and size.
const factCache = new Map<string, { m: number; s: number; at: string; app: boolean }>();
// One form (2026-11-02T10:00:00.000Z), so times written different ways still sort as text.
const iso = (v: string) => { const d = new Date(v); return isNaN(+d) ? v : d.toISOString(); };
function facts(dir: string, it: ProjectItem): { at: string; app: boolean } {
  const fallback = it.saved ? `${it.saved}T00:00:00.000Z` : "";
  const path = join(dir, `${it.id}.md`);
  try {
    const st = statSync(path); const c = factCache.get(path);
    if (c && c.m === st.mtimeMs && c.s === st.size) return c;
    const fm = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const pick = (k: string) => fm.match(new RegExp(`^${k}: *['"]?(\\d{4}-\\d{2}-\\d{2}T[^'"\\n]+)`, "m"))?.[1];
    const row = { m: st.mtimeMs, s: st.size, at: iso(pick("saved_at") ?? pick("ingested_at") ?? fallback), app: /^saved_via: *['"]?app\b/m.test(fm) };
    factCache.set(path, row);
    return row;
  } catch { return { at: fallback, app: false }; }
}
export function savedAt(dir: string, it: ProjectItem): string {
  const own = (it as any).saved_at; return own ? iso(String(own)) : facts(dir, it).at;
}

/** A person's own saved item: on an item shelf, or filed by the app onto any other catalog shelf (writing/,
 *  guides/…). Never their soul map, imported Google Docs, docs, skills or tests. */
export const NEVER = /^(soul|gdocs|docs|skills|tests|notes|team-board)\//;
export function isSaved(dir: string, it: ProjectItem): boolean {
  return !NEVER.test(it.id) && (ITEM_SHELVES.test(it.id) || facts(dir, it).app);
}

// ── Links, written one way ───────────────────────────────────────────────────
const TRACKING = /^(utm_\w+|fbclid|gclid|igshid|igsh|si|ref|ref_src|ref_url|mc_cid|mc_eid|_branch_\w+|share|feature|invite_code|epik|rdt)$/i;
/** The same link written the same way, so two saves of one pin or one video compare equal. */
export function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL; try { u = new URL(raw.trim()); } catch { return undefined; }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  // Pins: /pin/123/ and /pin/some-title--123/ on any Pinterest country domain are one pin.
  const pin = /(^|\.)pinterest\.[a-z.]+$/.test(host) && path.match(/^\/pin\/(?:[^/]*--)?(\d+)/);
  if (pin) return `pinterest:${pin[1]}`;
  if (host === "youtu.be") return `youtube:${path.slice(1)}`;
  if (/(^|\.)youtube\.com$/.test(host)) {
    const v = u.searchParams.get("v") ?? path.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (v) return `youtube:${v}`;
  }
  const ig = /(^|\.)instagram\.com$/.test(host) && path.match(/^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/);
  if (ig) return `instagram:${ig[1]}`;
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = keep.length ? `?${new URLSearchParams(keep).toString()}` : "";
  return `${host}${path}${q}`;
}

// ── File hashes, cached ──────────────────────────────────────────────────────
type HashRow = { m: number; s: number; h: string };
const hashCaches = new Map<string, { rows: Record<string, HashRow>; dirty: boolean }>();
const hashFile = (dir: string) => join(dir, ".hashes.json");
function cacheFor(dir: string) {
  let c = hashCaches.get(dir);
  if (!c) {
    let rows: Record<string, HashRow> = {};
    try { rows = store.read<Record<string, HashRow>>(hashFile(dir), {}); } catch { rows = {}; } // only a cache: rebuilt if unreadable
    c = { rows, dirty: false }; hashCaches.set(dir, c);
  }
  return c;
}
function flush(dir: string) {
  const c = hashCaches.get(dir); if (!c?.dirty) return;
  try { store.writeNow(hashFile(dir), c.rows); c.dirty = false; } catch (e) { console.error(`[dupes] ${hashFile(dir)}: ${(e as Error).message}`); }
}
/** sha1 of a file, read in 4 MB pieces so a long video doesn't sit in memory whole. */
function sha1Of(abs: string): string {
  const h = new Bun.CryptoHasher("sha1"); const buf = Buffer.alloc(4 * 1024 * 1024);
  const fd = openSync(abs, "r");
  try { let n: number; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
}
/** The file's sha1, from the cache when its size and modified time haven't changed. Missing file → undefined. */
export function fileHash(dir: string, root: string, file: string): string | undefined {
  const abs = toAbs(root, file); let st;
  try { st = statSync(abs); } catch { return undefined; }
  if (!st.isFile()) return undefined;
  const c = cacheFor(dir); const key = relative(root, abs); const row = c.rows[key];
  if (row && row.m === st.mtimeMs && row.s === st.size) return row.h;
  const h = sha1Of(abs); c.rows[key] = { m: st.mtimeMs, s: st.size, h }; c.dirty = true;
  return h;
}

/** An item's fingerprints. A link's preview picture doesn't count: two pages of one site often share it. */
export function fingerprints(dir: string, root: string, files: string[], url?: string): string[] {
  const keys: string[] = [];
  const u = normalizeUrl(url); if (u) keys.push(`u:${u}`);
  for (const f of files) {
    if (u && /(^|\/)preview\.\w+$/.test(f)) continue;
    const h = fileHash(dir, root, f); if (h) keys.push(`f:${h}`);
  }
  return keys;
}

// ── Groups of copies ─────────────────────────────────────────────────────────
export type Copy = { id: string; title: string; thumb?: string; kind: string; project?: string; placed?: string; saved_at: string };
export type DupeGroup = { keep: string; extras: string[]; items: Copy[]; same: "picture" | "link" | "file" };

const copyOf = (dir: string, it: ProjectItem): Copy => ({ id: it.id, title: it.title, thumb: it.thumb, kind: it.kind, project: it.project, placed: it.placed, saved_at: savedAt(dir, it) });
/** The copy to keep: one placed by hand, else one in a project, else the oldest. */
export function keeperOf(items: Copy[]): Copy {
  return [...items].sort((a, b) => (+!!b.placed - +!!a.placed) || (+!!b.project - +!!a.project) || a.saved_at.localeCompare(b.saved_at) || a.id.localeCompare(b.id))[0];
}

/** Every set of identical items in a person's library (saved items only: never soul/, gdocs/, docs/). */
export function findDuplicates(dir: string, root: string): DupeGroup[] {
  const pool = scanPages(dir).filter((it) => isSaved(dir, it));
  const parent = new Map<string, string>();
  const top = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const owner = new Map<string, string>(); const why = new Map<string, string>();
  for (const it of pool) {
    parent.set(it.id, it.id);
    for (const k of fingerprints(dir, root, it.files, it.url)) {
      const first = owner.get(k);
      if (!first) { owner.set(k, it.id); continue; }
      const a = top(first), b = top(it.id); if (a !== b) parent.set(b, a);
      why.set(it.id, k); why.set(first, k);
    }
  }
  flush(dir);
  const byRoot = new Map<string, ProjectItem[]>();
  for (const it of pool) { const r = top(it.id); byRoot.set(r, [...(byRoot.get(r) ?? []), it]); }
  const groups: DupeGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const items = members.map((it) => copyOf(dir, it)).sort((a, b) => a.saved_at.localeCompare(b.saved_at));
    const keep = keeperOf(items).id;
    const k = members.map((m) => why.get(m.id)).find(Boolean) ?? "";
    groups.push({ keep, extras: items.filter((x) => x.id !== keep).map((x) => x.id), items, same: k.startsWith("u:") ? "link" : items.every((x) => x.kind === "image") ? "picture" : "file" });
  }
  return groups.sort((a, b) => b.items[b.items.length - 1].saved_at.localeCompare(a.items[a.items.length - 1].saved_at));
}

/** The copies of one item (the group it belongs to), or undefined when it has none. */
export function groupOf(dir: string, root: string, id: string): DupeGroup | undefined {
  return findDuplicates(dir, root).find((g) => g.items.some((x) => x.id === id));
}

/** At filing time: is this save a copy of something already filed? Returns the copy to point at
 *  (the one that would be kept) and how many there will be counting this one. `files` may be absolute
 *  (a job's files) or relative to the data folder (a page's). */
export function duplicateOf(dir: string, root: string, files: string[], url?: string): { id: string; title: string; project?: string; count: number } | undefined {
  const mine = new Set(fingerprints(dir, root, files, url)); if (!mine.size) return undefined;
  const hits = scanPages(dir).filter((it) => isSaved(dir, it) && fingerprints(dir, root, it.files, it.url).some((k) => mine.has(k)));
  flush(dir);
  if (!hits.length) return undefined;
  const keep = keeperOf(hits.map((it) => copyOf(dir, it)));
  return { id: keep.id, title: keep.title, project: keep.project, count: hits.length + 1 };
}

// ── The Clarify card ─────────────────────────────────────────────────────────
// One card per original: a later copy replaces the card (cues.add drops the same kind + item), so three saves
// of one pin ask once, "Same picture 3 times". The kind "duplicate" is new; resolveCue sends it to trash.ts.
// Wording is the UX draft and waits for Max's OK.
export function duplicateCue(of: { id: string; count: number }, saved: { title: string; snippet: string; thumb?: string; kind?: string }) {
  const what = saved.kind === "image" || saved.kind === "video" || (saved.thumb && /\.(png|jpe?g|gif|webp|heic)$/i.test(saved.thumb)) ? "Same picture" : "Saved";
  return {
    kind: "duplicate" as any, item: of.id, title: saved.title, snippet: saved.snippet, thumb: saved.thumb,
    question: `${what} ${of.count} times.`,
    options: [{ id: "one", label: "Keep one" }, { id: "all", label: "Keep all" }],
  };
}

export const _test = { reset() { hashCaches.clear(); factCache.clear(); } };
