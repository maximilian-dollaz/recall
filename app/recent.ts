// Recent saves: what drops down under the search box on Find (it replaces the "Recently saved" row).
// Newest first, from four places, so a save shows the moment it lands and never silently disappears:
//   inbox/          being filed by the librarian                 → "filing"
//   inbox-failed/   saved, but the librarian couldn't file it    → "failed"
//   held/           waiting on a Clarify card (Private/Shareable) → "waiting"
//   filed pages     in a project → "filed"; in none → "unsorted"; a Clarify card still open → "waiting"
//
// findRoutes() also carries the Find package's other routes: delete with undo, the trash, and duplicates.

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { scanPages, type Project } from "./projects.ts";
import * as cues from "./cues.ts";
import { vaultFor } from "./vault.ts";
import { savedAt, isSaved, findDuplicates } from "./dupes.ts";
import * as trash from "./trash.ts";
import type { Person } from "./identity.ts";
import type { Catalog } from "./librarian.ts";

const VISUAL = /\.(png|jpe?g|gif|webp|heic|mp4|mov|m4v|webm)$/i; // the same as server.ts: files that get a picture
export type Status = "filing" | "filed" | "unsorted" | "waiting" | "failed";
export type RecentItem = {
  id: string; title: string; thumb?: string; saved_at: string; project?: string; projectName?: string; status: Status;
  snippet: string; notes?: string; kind?: string; by?: string; local?: boolean; cue?: string;
};

const iso = (v?: string) => { const d = new Date(v ?? ""); return isNaN(+d) ? v ?? "" : d.toISOString(); }; // one form, so it sorts as text
type Job = { id: string; notes?: string; url?: string; files?: string[]; created?: string; keepLocal?: boolean; who?: string };
function jobs(dir: string, folder: string): Job[] {
  const d = join(dir, folder); if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith(".json")).flatMap((n) => { try { return [JSON.parse(readFileSync(join(d, n), "utf8"))]; } catch { return []; } });
}

/** The newest saves for one person. `projects` names the project ids; `root` is the data folder file paths hang off. */
export async function recentFor(person: Pick<Person, "dir">, opts: { root: string; projects: Project[]; limit?: number }): Promise<{ items: RecentItem[]; filing: number; failed: number; waiting: number }> {
  const dir = person.dir; const limit = Math.max(1, Math.min(60, opts.limit ?? 12));
  const rel = (f: string) => f.startsWith(opts.root + "/") ? f.slice(opts.root.length + 1) : f;
  const thumbOf = (files: string[] = []) => files.map(rel).find((f) => VISUAL.test(f));
  const names = new Map(opts.projects.map((p) => [p.id, p.name]));
  const open = (await cues.list(dir)).filter((c) => c.kind !== "when"); // "when" asks about a reminder, not where it goes
  const cueFor = new Map(open.map((c) => [c.item, c]));

  // The inbox is read before the pages: a save filed in between then shows twice for a moment (and is
  // dropped below by its job id), rather than not at all.
  const filing = jobs(dir, "inbox"), failed = jobs(dir, "inbox-failed"), held = jobs(dir, "held");
  const pages = scanPages(dir).filter((it) => isSaved(dir, it));
  const filedTails = new Set(pages.map((it) => it.id.slice(-6)));

  const out: RecentItem[] = [];
  const pending = (j: Job, status: Status, snippet: string) => {
    if (filedTails.has(j.id.slice(-6))) return;
    const c = cueFor.get(j.id);
    out.push({ id: `pending:${j.id}`, title: c?.title || (j.notes ?? "").slice(0, 80) || j.url || "New item", thumb: thumbOf(j.files), saved_at: iso(j.created),
      status, snippet: c?.question ?? snippet, notes: j.notes || undefined, by: j.who || undefined, local: !!j.keepLocal, cue: c?.id });
  };
  // The words already on Find today, kept as they are.
  for (const j of filing) pending(j, "filing", "Being filed by the librarian…");
  for (const j of failed) pending(j, "failed", "Saved, but not filed yet. It's tried again every hour.");
  for (const j of held) pending(j, "waiting", "");

  // savedAt reads each page's time once and caches it by modified time, so all pages is cheap.
  for (const it of pages) {
    const c = cueFor.get(it.id);
    out.push({ id: it.id, title: it.title, thumb: it.thumb, saved_at: savedAt(dir, it), project: it.project, projectName: it.project ? names.get(it.project) ?? it.project : undefined,
      status: c ? "waiting" : it.project ? "filed" : "unsorted", snippet: it.summary, notes: it.notes ? it.notes.slice(0, 400) : undefined, kind: it.kind, by: it.by, cue: c?.id });
  }
  // Private (vault) saves are the person's too; they never go in a project.
  for (const v of vaultFor(dir).list(undefined, limit)) {
    out.push({ id: `vault:${v.id}`, title: v.title, thumb: thumbOf(v.files), saved_at: iso(v.created), status: "filed", snippet: v.summary, notes: v.notes ? v.notes.slice(0, 400) : undefined, local: true });
  }
  out.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  return { items: out.slice(0, limit), filing: filing.length, failed: failed.length, waiting: open.length };
}

// ── Routes ───────────────────────────────────────────────────────────────────
type Handler = (req: Request, p: Person) => Promise<Response>;
export type FindDeps = trash.TrashDeps & { loadCatalog: () => Promise<Catalog> };
const json = (data: unknown, status = 400) => Response.json(data, { status });
const body = async (req: Request) => { try { return await req.json(); } catch { return {}; } };

/** Find's routes, to spread into server.ts's `routes`. */
export function findRoutes(withPerson: (fn: Handler) => (req: Request) => Promise<Response>, deps: FindDeps) {
  return {
    "/api/recent": withPerson(async (req, p) => {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 12) || 12;
      const catalog = await deps.loadCatalog();
      return json(await recentFor(p, { root: deps.root, projects: ((catalog as any).projects ?? []) as Project[], limit }), 200);
    }),
    // {id} or {ids:[…]} → {ok, undo, deleted, missing, refused}
    "/api/delete": { POST: withPerson(async (req, p) => {
      const b = await body(req);
      const ids = (Array.isArray(b.ids) ? b.ids : b.id ? [b.id] : []).map(String).slice(0, 200);
      if (!ids.length) return json({ error: "Nothing to delete." });
      const r = await trash.deleteItems(p, ids, deps);
      return r.ok ? json(r, 200) : json({ ...r, error: r.refused[0]?.why ?? "Not found." }, r.missing.length && !r.refused.length ? 404 : 400);
    }) },
    // {undo, id?} → {ok, restored, failed}
    "/api/undelete": { POST: withPerson(async (req, p) => {
      const b = await body(req);
      const r = await trash.undelete(p, String(b.undo ?? ""), deps, b.id ? String(b.id) : undefined);
      return r.ok ? json(r, 200) : json({ ...r, error: "Nothing to put back." }, r.failed.length ? 500 : 404);
    }) },
    "/api/trash": withPerson(async (_req, p) => json({ items: trash.listTrash(p.dir) }, 200)),
    // Groups of identical items; ?project=<id> narrows to groups with a copy in that project.
    "/api/duplicates": withPerson(async (req, p) => {
      const project = new URL(req.url).searchParams.get("project");
      const groups = findDuplicates(p.dir, deps.root).filter((g) => !project || g.items.some((x) => x.project === project));
      return json({ groups }, 200);
    }),
    // "Remove 3 duplicates": {project?} cleans that project's groups (or all), {id} the group that item is in.
    // Keeps one per group (placed by hand, else in a project, else the oldest), one undo for the lot.
    "/api/duplicates/clean": { POST: withPerson(async (req, p) => {
      const b = await body(req);
      const groups = findDuplicates(p.dir, deps.root).filter((g) => b.id ? g.items.some((x) => x.id === String(b.id)) : !b.project || g.items.some((x) => x.project === String(b.project)));
      const extras = groups.flatMap((g) => g.extras);
      if (!extras.length) return json({ ok: true, deleted: [], kept: [] }, 200);
      const r = await trash.deleteItems(p, extras, deps);
      return json({ ...r, kept: groups.map((g) => g.keep) }, r.ok ? 200 : 400);
    }) },
  };
}
