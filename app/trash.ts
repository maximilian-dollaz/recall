// Delete, with undo. Replaces server.ts's remove(), which deleted the page outright (GBrain's delete_page
// removes the .md) and only kept the files.
//
// Before anything is deleted, everything needed to put it back is written to the person's own trash:
//   <person>/.trash/<ts>-<item>/page.md     the page exactly as GBrain had it
//   <person>/.trash/<ts>-<item>/meta.json   slug, source, tags, the reminder and cues it had, where its files were
//   <person>/.trash/<ts>-<item>/files/...   its folder(s) from files/ or vault/, moved here whole
// One delete (one item or several picked together) shares one undo token. Undo puts the page back through
// GBrain, re-adds its tags (project: and shelf: too), moves the folders back and restores the reminder and cues.
// Nothing is ever removed for good here except by purge(), which nothing schedules (Max decides how long).

import { join, dirname, relative, isAbsolute } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as gb from "./gbrain.ts";
import * as store from "./store.ts";
import * as cues from "./cues.ts";
import { addReminder, removeReminder, type Reminder } from "./reminders.ts";
import { vaultFor, type VaultItem } from "./vault.ts";
import { scanPages, invalidate as invalidateScan, ITEM_SHELVES } from "./projects.ts";
import { NEVER } from "./dupes.ts";
import type { Person } from "./identity.ts";

/** The few GBrain calls delete and undo need, so tests can stand in for the database. */
export type Lib = {
  getPage(scope: gb.Scope, slug: string): Promise<any>;
  putPage(scope: gb.Scope, slug: string, content: string): Promise<any>;
  deletePage(scope: gb.Scope, slug: string): Promise<any>;
  addTag(scope: gb.Scope, slug: string, tag: string): Promise<any>;
};
export type TrashDeps = {
  root: string;                       // the data folder files: paths are relative to (DATA in paths.ts)
  lib?: Lib;                          // GBrain; tests pass a stand-in
  invalidate?: (p: Who) => void;      // the server's own caches (search index, team boards)
};
type Who = Pick<Person, "id" | "dir" | "source">;

type Meta = {
  v: 1; undo: string; id: string; kind: "page" | "vault" | "job"; deleted_at: string;
  person: string; source: string; slug?: string; title: string;
  tags: string[]; project?: string; shelf?: string;
  moved: { from: string; to: string }[];   // folders, relative to the person's dir → relative to the entry
  kept: string[];                          // folders left in place because another item still uses them
  reminder?: Reminder; cues: cues.Cue[];
  vault?: VaultItem;                       // a private item's row, put back as it was
  job?: { folder: "inbox-failed" | "held"; file: string }; // a save that never got filed
};

const trashDir = (dir: string) => join(dir, ".trash");
const safeName = (s: string) => s.replace(/^.*\//, "").replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 80) || "item";
const TOKEN = /^\d{13}-[a-z0-9]{6}$/;
const SLUG = /^[A-Za-z0-9][\w-]*(\/[\w-]+)+$/; // shelf/name, nothing that climbs out of the library
const JOB = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{1,8}$/;
const toAbs = (root: string, f: string) => (isAbsolute(f) ? f : join(root, f));

/** The one folder a file belongs to (files/<job> or vault/<job>), relative to the person's dir. Never files/ itself. */
function folderOf(dir: string, root: string, f: string): string | undefined {
  const rel = relative(dir, toAbs(root, f));
  const m = rel.match(/^((?:files|vault)\/[^/]+)\/./);
  return m ? m[1] : undefined;
}

function readMeta(entry: string): Meta | undefined {
  try { return JSON.parse(readFileSync(join(entry, "meta.json"), "utf8")); } catch { return undefined; }
}

function frontmatter(content: string): any {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1]; if (!fm) return {};
  try { return Bun.YAML.parse(fm) ?? {}; } catch { return {}; }
}

/** The reminder an item has, read without changing the ledger. */
function reminderOf(dir: string, id: string): Reminder | undefined {
  try { return store.read<Reminder[]>(join(dir, "reminders.json"), []).find((r) => r.id === id); } catch { return undefined; }
}

// ── Delete ───────────────────────────────────────────────────────────────────
export type DeleteResult = { ok: boolean; undo?: string; deleted: string[]; missing: string[]; refused: { id: string; why: string }[] };

/** Move items to the person's trash. Only their own saved items: pages on item shelves, private (vault) items,
 *  and saves that are waiting (held) or stuck (inbox-failed). A save still being filed is refused. */
export async function deleteItems(person: Who, ids: string[], deps: TrashDeps): Promise<DeleteResult> {
  const lib = deps.lib ?? gb;
  const ts = Date.now();
  const undo = `${ts}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
  const out: DeleteResult = { ok: false, deleted: [], missing: [], refused: [] };
  const others = () => scanPages(person.dir); // who else uses a folder (read once per item; it's cached)

  for (const raw of [...new Set(ids.map(String))]) {
    const id = raw.trim();
    const entry = join(trashDir(person.dir), `${ts}-${safeName(id)}`);
    try {
      let meta: Meta; let page = ""; let files: string[] = [];
      const base = { v: 1 as const, undo, id, deleted_at: new Date(ts).toISOString(), person: person.id, source: person.source, moved: [], kept: [], cues: (await cues.list(person.dir)).filter((c) => c.item === id), reminder: reminderOf(person.dir, id) };

      if (id.startsWith("vault:")) {
        const v = vaultFor(person.dir).get(id.slice(6)); if (!v) { out.missing.push(id); continue; }
        files = v.files; meta = { ...base, kind: "vault", title: v.title, tags: v.tags, shelf: v.shelf, vault: v };
      } else if (id.startsWith("pending:")) {
        const jobId = id.slice(8); if (!JOB.test(jobId)) { out.refused.push({ id, why: "bad id" }); continue; }
        if (existsSync(join(person.dir, "inbox", `${jobId}.json`))) { out.refused.push({ id, why: "Still being filed. Try again in a moment." }); continue; }
        const folder = (["inbox-failed", "held"] as const).find((f) => existsSync(join(person.dir, f, `${jobId}.json`)));
        if (!folder) { out.missing.push(id); continue; }
        const job = JSON.parse(readFileSync(join(person.dir, folder, `${jobId}.json`), "utf8"));
        files = Array.isArray(job.files) ? job.files : [];
        meta = { ...base, kind: "job", title: String(job.notes ?? "").slice(0, 80) || job.url || "New item", tags: [], job: { folder, file: `${jobId}.json` },
          cues: (await cues.list(person.dir)).filter((c) => c.item === jobId) }; // a held save's privacy card is keyed by the job id
      } else {
        if (!SLUG.test(id) || NEVER.test(id)) { out.refused.push({ id, why: "Only your own saved items can be deleted here." }); continue; }
        const p = await lib.getPage(gb.scopeFor(person.source), id).catch(() => null);
        page = p?.content ?? p?.markdown ?? ""; if (!page) { out.missing.push(id); continue; }
        const fm = frontmatter(page);
        // An item shelf, or a page the app filed on another shelf (writing/, guides/…).
        if (!ITEM_SHELVES.test(id) && fm.saved_via !== "app") { out.refused.push({ id, why: "Only your own saved items can be deleted here." }); continue; }
        files = Array.isArray(fm.files) ? fm.files.map(String) : [];
        const tags = [...new Set([...(Array.isArray(p.tags) ? p.tags : []), ...(Array.isArray(fm.tags) ? fm.tags : [])].map(String))];
        meta = { ...base, kind: "page", slug: id, title: String(fm.title ?? p.title ?? id), tags, project: fm.project ? String(fm.project) : undefined, shelf: String(fm.shelf ?? id.split("/")[0]) };
      }

      // Write what's needed to undo first, so a crash part-way leaves something to restore from.
      mkdirSync(entry, { recursive: true });
      if (page) writeFileSync(join(entry, "page.md"), page);
      if (meta.kind === "job") writeFileSync(join(entry, "job.json"), readFileSync(join(person.dir, meta.job!.folder, meta.job!.file)));
      store.writeNow(join(entry, "meta.json"), meta);

      // A folder another item still points at stays where it is (moving it would break that item).
      const folders = [...new Set(files.map((f) => folderOf(person.dir, deps.root, f)).filter((x): x is string => !!x))];
      const usedElsewhere = (folder: string) => others().some((it) => it.id !== id && it.files.some((f) => folderOf(person.dir, deps.root, f) === folder));
      for (const folder of folders) {
        if (!existsSync(join(person.dir, folder))) continue;
        if (usedElsewhere(folder)) { meta.kept.push(folder); continue; }
        const to = join("files", folder); // files/files/<job> or files/vault/<job>: the original path, kept readable
        mkdirSync(dirname(join(entry, to)), { recursive: true });
        renameSync(join(person.dir, folder), join(entry, to));
        meta.moved.push({ from: folder, to });
      }
      store.writeNow(join(entry, "meta.json"), meta);

      try {
        if (meta.kind === "page") await lib.deletePage(gb.scopeFor(person.source), id);
        else if (meta.kind === "vault") vaultFor(person.dir).delete(id.slice(6));
        else rmSync(join(person.dir, meta.job!.folder, meta.job!.file), { force: true });
      } catch (e) {
        // The page is still there: put its folders back and forget this entry, so nothing is half-deleted.
        for (const m of meta.moved) renameSync(join(entry, m.to), join(person.dir, m.from));
        rmSync(entry, { recursive: true, force: true });
        throw e;
      }
      await removeReminder(person.dir, id).catch(() => {});
      await cues.forget(person.dir, meta.kind === "job" ? id.slice(8) : id).catch(() => {});
      out.deleted.push(id);
      invalidateScan(person.dir); // the next item's "used elsewhere" check must not see this one
    } catch (e) {
      console.error(`[trash] ${person.id}: ${id} not deleted: ${String(e).slice(0, 200)}`);
      out.refused.push({ id, why: "Couldn't delete this just now." });
    }
  }
  if (out.deleted.length) {
    deps.invalidate?.(person);
    console.log(`[trash] ${person.id}: deleted ${out.deleted.length} (${undo})`);
  }
  out.ok = out.deleted.length > 0;
  if (out.ok) out.undo = undo;
  return out;
}

// ── Undo ─────────────────────────────────────────────────────────────────────
export type UndoResult = { ok: boolean; restored: string[]; failed: { id: string; why: string }[] };

/** Put back everything one delete took (or just `only`, one item of it, for the Trash list). */
export async function undelete(person: Who, undo: string, deps: TrashDeps, only?: string): Promise<UndoResult> {
  const lib = deps.lib ?? gb;
  const out: UndoResult = { ok: false, restored: [], failed: [] };
  if (!TOKEN.test(undo)) return out;
  const t = trashDir(person.dir); if (!existsSync(t)) return out;
  const ts = undo.split("-")[0];
  for (const name of readdirSync(t).filter((n) => n.startsWith(`${ts}-`))) {
    const entry = join(t, name); const meta = readMeta(entry);
    if (!meta || meta.undo !== undo || meta.person !== person.id || (only && meta.id !== only)) continue;
    try {
      if (meta.kind === "page") {
        // Already back (undo pressed twice, or saved again since): leave the page as it is.
        if (!existsSync(join(person.dir, `${meta.slug}.md`))) {
          const scope = gb.scopeFor(person.source);
          await lib.putPage(scope, meta.slug!, readFileSync(join(entry, "page.md"), "utf8"));
          const tags = new Set(meta.tags);
          if (meta.project) tags.add(`project:${meta.project}`);
          if (meta.shelf) tags.add(`shelf:${meta.shelf}`);
          for (const tag of tags) await lib.addTag(scope, meta.slug!, tag).catch(() => {});
        }
      }
      for (const m of meta.moved) {
        const back = join(person.dir, m.from);
        if (existsSync(join(entry, m.to)) && !existsSync(back)) { mkdirSync(dirname(back), { recursive: true }); renameSync(join(entry, m.to), back); }
      }
      if (meta.kind === "vault" && meta.vault) vaultFor(person.dir).put(meta.vault);
      if (meta.kind === "job" && meta.job) { mkdirSync(join(person.dir, meta.job.folder), { recursive: true }); renameSync(join(entry, "job.json"), join(person.dir, meta.job.folder, meta.job.file)); }
      if (meta.reminder) await addReminder(person.dir, meta.reminder);
      for (const c of meta.cues) { const { id: _id, created: _c, ...rest } = c; await cues.add(person.dir, rest); }
      rmSync(entry, { recursive: true, force: true });
      out.restored.push(meta.id);
    } catch (e) {
      console.error(`[trash] ${person.id}: ${meta.id} not restored: ${String(e).slice(0, 200)}`);
      out.failed.push({ id: meta.id, why: "Couldn't put this back just now." });
    }
  }
  if (out.restored.length) { invalidateScan(person.dir); deps.invalidate?.(person); console.log(`[trash] ${person.id}: restored ${out.restored.length} (${undo})`); }
  out.ok = out.restored.length > 0;
  return out;
}

// ── Trash list and purge ─────────────────────────────────────────────────────
export type TrashRow = { undo: string; id: string; title: string; kind: string; deleted_at: string; project?: string };
/** What's in the trash, newest first (entries from the old remove(), which kept only files, are left out). */
export function listTrash(dir: string): TrashRow[] {
  const t = trashDir(dir); if (!existsSync(t)) return [];
  return readdirSync(t).map((n) => readMeta(join(t, n))).filter((m): m is Meta => !!m)
    .map((m) => ({ undo: m.undo, id: m.id, title: m.title, kind: m.kind, deleted_at: m.deleted_at, project: m.project }))
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

/** Remove trash entries older than `days` for good. Exported, not scheduled: Max decides the retention.
 *  Covers the old remove()'s `<ts>-<folder>` entries too. Returns how many went. */
export function purge(dir: string, days = 30, now = Date.now()): number {
  const t = trashDir(dir); if (!existsSync(t)) return 0;
  const cutoff = now - days * 86_400_000; let n = 0;
  for (const name of readdirSync(t)) {
    const ts = Number(name.match(/^(\d{13})-/)?.[1]); if (!ts || ts >= cutoff) continue;
    const p = join(t, name); if (!statSync(p).isDirectory()) continue;
    rmSync(p, { recursive: true, force: true }); n++;
  }
  if (n) console.log(`[trash] ${dir}: purged ${n} older than ${days} days`);
  return n;
}
