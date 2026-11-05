// Find package B: delete with undo, duplicates, and the recent-saves feed. Everything runs in a temp data
// folder (RECALL_DATA points there before any app module loads), and GBrain is a stand-in that keeps pages
// in memory and writes/removes the .md the way the real server does, so no database is needed.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recall-trash-test-"));
process.env.RECALL_DATA = ROOT;
mkdirSync(join(ROOT, "library"), { recursive: true });

const trash = await import("../app/trash.ts");
const dupes = await import("../app/dupes.ts");
const recent = await import("../app/recent.ts");
const reminders = await import("../app/reminders.ts");
const cues = await import("../app/cues.ts");
const projects = await import("../app/projects.ts");
const { vaultFor } = await import("../app/vault.ts");

beforeAll(() => { console.log(`temp data root: ${ROOT}`); });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ── A scratch library and a stand-in for GBrain ──────────────────────────────
let n = 0;
function person() {
  const id = `p${++n}`; const dir = join(ROOT, "libraries", id);
  mkdirSync(join(dir, "files"), { recursive: true });
  return { id, dir, source: id, name: id, email: `${id}@x` };
}
function fakeLib(dir: string) {
  const tags = new Map<string, Set<string>>(); const calls: string[] = [];
  return {
    tags, calls, failDelete: false,
    async getPage(_s: any, slug: string) {
      const p = join(dir, `${slug}.md`); if (!existsSync(p)) throw new Error("page_not_found");
      return { slug, content: readFileSync(p, "utf8"), tags: [...(tags.get(slug) ?? [])] };
    },
    async putPage(_s: any, slug: string, content: string) { calls.push(`put ${slug}`); mkdirSync(dirname(join(dir, `${slug}.md`)), { recursive: true }); writeFileSync(join(dir, `${slug}.md`), content); },
    async deletePage(_s: any, slug: string) { if ((this as any).failDelete) throw new Error("library busy"); calls.push(`delete ${slug}`); rmSync(join(dir, `${slug}.md`)); tags.delete(slug); },
    async addTag(_s: any, slug: string, tag: string) { const t = tags.get(slug) ?? new Set(); t.add(tag); tags.set(slug, t); },
  };
}
/** A filed page as GBrain leaves it on disk, with its files under files/<job>/. */
function page(p: { dir: string }, slug: string, o: { title?: string; project?: string; placed?: string; files?: { name: string; data: string | Uint8Array }[]; url?: string; saved?: string; at?: string; notes?: string; job?: string; app?: boolean } = {}) {
  const job = o.job ?? `2026-11-02-${Math.random().toString(36).slice(2, 8)}`;
  const rels: string[] = [];
  for (const f of o.files ?? []) { const abs = join(p.dir, "files", job, f.name); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, f.data); rels.push(abs.slice(ROOT.length + 1)); }
  const fm = [
    "---", "type: project", `title: ${o.title ?? slug}`, `saved: '${o.saved ?? "2026-11-02"}T00:00:00.000Z'`, `shelf: ${slug.split("/")[0]}`, "state: idea",
    o.project ? `project: ${o.project}` : null, o.placed ? `placed: ${o.placed}` : null, o.url ? `url: ${o.url}` : null,
    `ingested_at: '${o.at ?? "2026-11-02T10:00:00.000Z"}'`, o.app ? "saved_via: app" : null,
    rels.length ? `files:\n${rels.map((r) => `  - ${r}`).join("\n")}` : null,
    "tags:\n  - spider-man\n  - comic", "---",
  ].filter(Boolean).join("\n");
  const body = `\n> A summary of ${slug}.\n\n${o.notes ? `## Why I saved this\n\n${o.notes}\n\n` : ""}`;
  mkdirSync(dirname(join(p.dir, `${slug}.md`)), { recursive: true });
  writeFileSync(join(p.dir, `${slug}.md`), fm + body);
  projects.invalidate(p.dir);
  return { slug, job, rels };
}
const deps = (lib: any) => ({ root: ROOT, lib, invalidate: () => {} });
const quiet = <T>(fn: () => Promise<T>) => { const e = console.error, l = console.log; console.error = console.log = () => {}; return fn().finally(() => { console.error = e; console.log = l; }); };

// ── Delete and undo ──────────────────────────────────────────────────────────
test("delete keeps everything needed to undo, and undo puts it all back", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const { slug, job, rels } = page(p, "projects/2026-11-02-spider-man-abc123", { project: "zero-proof", files: [{ name: "web-1.jpg", data: "PIXELS" }], notes: "for the bar" });
  lib.tags.set(slug, new Set(["spider-man", "shelf:projects"]));
  await reminders.addReminder(p.dir, { id: slug, title: "Spider", summary: "s", local: false, saved: "2026-11-02", due: "2026-12-01" });
  await cues.add(p.dir, { kind: "project", item: slug, title: "Spider", snippet: "s", question: "Which project?", options: [] });
  const before = readFileSync(join(p.dir, `${slug}.md`), "utf8");

  const r = await quiet(() => trash.deleteItems(p, [slug], deps(lib)));
  expect(r.ok).toBe(true); expect(r.deleted).toEqual([slug]); expect(r.undo).toMatch(/^\d{13}-[a-z0-9]{6}$/);
  expect(existsSync(join(p.dir, `${slug}.md`))).toBe(false);
  expect(existsSync(join(p.dir, "files", job))).toBe(false);
  expect((await reminders.due(p.dir)).length).toBe(0);
  expect(readFileSync(join(p.dir, "reminders.json"), "utf8")).not.toContain(slug);
  expect((await cues.list(p.dir)).length).toBe(0);
  const [entry] = readdirSync(join(p.dir, ".trash"));
  const meta = JSON.parse(readFileSync(join(p.dir, ".trash", entry, "meta.json"), "utf8"));
  expect(meta).toMatchObject({ slug, source: p.source, project: "zero-proof", shelf: "projects", undo: r.undo, kind: "page" });
  expect(meta.tags).toContain("spider-man"); expect(meta.reminder.due).toBe("2026-12-01"); expect(meta.cues.length).toBe(1);
  expect(readFileSync(join(p.dir, ".trash", entry, "page.md"), "utf8")).toBe(before);
  expect(projects.scanPages(p.dir).some((it) => it.id === slug)).toBe(false); // the projects cache was dropped

  const u = await quiet(() => trash.undelete(p, r.undo!, deps(lib)));
  expect(u).toMatchObject({ ok: true, restored: [slug] });
  expect(readFileSync(join(p.dir, `${slug}.md`), "utf8")).toBe(before);
  expect(readFileSync(join(ROOT, rels[0]), "utf8")).toBe("PIXELS");
  expect([...lib.tags.get(slug)!]).toEqual(expect.arrayContaining(["spider-man", "comic", "project:zero-proof", "shelf:projects"]));
  expect(JSON.parse(readFileSync(join(p.dir, "reminders.json"), "utf8"))[0]).toMatchObject({ id: slug, due: "2026-12-01" });
  expect((await cues.list(p.dir))[0]).toMatchObject({ item: slug, kind: "project" });
  expect(readdirSync(join(p.dir, ".trash"))).toEqual([]);
  expect(projects.scanPages(p.dir).some((it) => it.id === slug)).toBe(true);
  // Pressing undo twice does nothing.
  expect((await trash.undelete(p, r.undo!, deps(lib))).ok).toBe(false);
});

test("several at once share one undo", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const a = page(p, "inspiration/2026-11-02-a-aaaaaa", { files: [{ name: "a.jpg", data: "A" }] });
  const b = page(p, "inspiration/2026-11-02-b-bbbbbb", { files: [{ name: "b.jpg", data: "B" }] });
  const c = page(p, "links/2026-11-02-c-cccccc", {});
  const r = await quiet(() => trash.deleteItems(p, [a.slug, b.slug, c.slug, a.slug], deps(lib)));
  expect(r.deleted.sort()).toEqual([a.slug, b.slug, c.slug].sort());
  expect(trash.listTrash(p.dir).map((x) => x.undo)).toEqual([r.undo!, r.undo!, r.undo!]);
  const u = await quiet(() => trash.undelete(p, r.undo!, deps(lib)));
  expect(u.restored.sort()).toEqual([a.slug, b.slug, c.slug].sort());
  for (const s of [a, b, c]) expect(existsSync(join(p.dir, `${s.slug}.md`))).toBe(true);
  expect(readFileSync(join(ROOT, b.rels[0]), "utf8")).toBe("B");
});

test("undo can bring back one item of a batch (the Trash list)", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const a = page(p, "inspiration/2026-11-02-a-aaaaaa"); const b = page(p, "inspiration/2026-11-02-b-bbbbbb");
  const r = await quiet(() => trash.deleteItems(p, [a.slug, b.slug], deps(lib)));
  const u = await quiet(() => trash.undelete(p, r.undo!, deps(lib), b.slug));
  expect(u.restored).toEqual([b.slug]);
  expect(trash.listTrash(p.dir).map((x) => x.id)).toEqual([a.slug]);
});

test("only the person's own saved items: never soul/, gdocs/, docs/, odd ids or someone else's token", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  page(p, "soul/rules"); page(p, "gdocs/plan");
  const r = await quiet(() => trash.deleteItems(p, ["soul/rules", "gdocs/plan", "projects/../soul/rules", "../x", "projects/nope-123456"], deps(lib)));
  expect(r.ok).toBe(false); expect(r.undo).toBeUndefined();
  expect(r.refused.map((x) => x.id)).toEqual(["soul/rules", "gdocs/plan", "projects/../soul/rules", "../x"]);
  expect(r.missing).toEqual(["projects/nope-123456"]);
  expect(existsSync(join(p.dir, "soul/rules.md"))).toBe(true);
  // Another catalog shelf counts when the app filed it there; a hand-made page there doesn't.
  const w = page(p, "writing/2026-11-02-draft-wwwwww", { app: true }); page(p, "writing/hand-made");
  const r2 = await quiet(() => trash.deleteItems(p, [w.slug, "writing/hand-made"], deps(lib)));
  expect(r2.deleted).toEqual([w.slug]); expect(r2.refused.map((x) => x.id)).toEqual(["writing/hand-made"]);
  // Another person can't undo it, and a malformed token reads nothing.
  const own = page(p, "projects/2026-11-02-mine-mmmmmm"); const d = await quiet(() => trash.deleteItems(p, [own.slug], deps(lib)));
  const other = { ...person(), dir: p.dir, id: "intruder" };
  expect((await trash.undelete(other, d.undo!, deps(lib))).ok).toBe(false);
  expect((await trash.undelete(p, "../../etc", deps(lib))).ok).toBe(false);
});

test("a folder another item still uses stays where it is", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const a = page(p, "projects/2026-11-02-a-aaaaaa", { job: "2026-11-02-shared", files: [{ name: "x.jpg", data: "X" }] });
  const b = page(p, "projects/2026-11-02-b-bbbbbb", { job: "2026-11-02-shared", files: [{ name: "y.jpg", data: "Y" }] });
  const r = await quiet(() => trash.deleteItems(p, [a.slug], deps(lib)));
  expect(r.ok).toBe(true);
  expect(readFileSync(join(ROOT, b.rels[0]), "utf8")).toBe("Y");
  expect(readFileSync(join(ROOT, a.rels[0]), "utf8")).toBe("X");
});

test("if the library can't delete the page, nothing is half-deleted", async () => {
  const p = person(); const lib = fakeLib(p.dir); (lib as any).failDelete = true;
  const a = page(p, "projects/2026-11-02-a-aaaaaa", { files: [{ name: "x.jpg", data: "X" }] });
  const r = await quiet(() => trash.deleteItems(p, [a.slug], deps(lib)));
  expect(r.ok).toBe(false); expect(r.refused[0].id).toBe(a.slug);
  expect(existsSync(join(p.dir, `${a.slug}.md`))).toBe(true);
  expect(readFileSync(join(ROOT, a.rels[0]), "utf8")).toBe("X");
  expect(readdirSync(join(p.dir, ".trash"))).toEqual([]);
});

test("private (vault) items delete and come back", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const abs = join(p.dir, "vault", "2026-11-02-vvvvvv", "note.txt"); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, "secret");
  vaultFor(p.dir).put({ id: "2026-11-02-vvvvvv", title: "Private", shelf: "reference", tags: ["x"], summary: "s", notes: "n", body: "b", files: [abs.slice(ROOT.length + 1)], created: "2026-11-02T10:00:00Z" });
  const r = await quiet(() => trash.deleteItems(p, ["vault:2026-11-02-vvvvvv"], deps(lib)));
  expect(r.ok).toBe(true); expect(vaultFor(p.dir).get("2026-11-02-vvvvvv")).toBeNull(); expect(existsSync(abs)).toBe(false);
  await quiet(() => trash.undelete(p, r.undo!, deps(lib)));
  expect(vaultFor(p.dir).get("2026-11-02-vvvvvv")?.title).toBe("Private"); expect(readFileSync(abs, "utf8")).toBe("secret");
});

test("a held or stuck save can be deleted; one still being filed can't", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const file = join(p.dir, "files", "2026-11-02-hhhhhh", "pic.jpg"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "H");
  mkdirSync(join(p.dir, "held"), { recursive: true }); mkdirSync(join(p.dir, "inbox"), { recursive: true });
  writeFileSync(join(p.dir, "held", "2026-11-02-hhhhhh.json"), JSON.stringify({ id: "2026-11-02-hhhhhh", notes: "personal", files: [file], created: "2026-11-02T10:00:00Z" }));
  writeFileSync(join(p.dir, "inbox", "2026-11-02-iiiiii.json"), JSON.stringify({ id: "2026-11-02-iiiiii", notes: "", files: [] }));
  await cues.add(p.dir, { kind: "privacy", item: "2026-11-02-hhhhhh", title: "Personal", snippet: "", question: "Private?", options: [] });
  const r = await quiet(() => trash.deleteItems(p, ["pending:2026-11-02-hhhhhh", "pending:2026-11-02-iiiiii"], deps(lib)));
  expect(r.deleted).toEqual(["pending:2026-11-02-hhhhhh"]); expect(r.refused[0].id).toBe("pending:2026-11-02-iiiiii");
  expect(existsSync(join(p.dir, "held", "2026-11-02-hhhhhh.json"))).toBe(false); expect(existsSync(file)).toBe(false);
  expect((await cues.list(p.dir)).length).toBe(0);
  await quiet(() => trash.undelete(p, r.undo!, deps(lib)));
  expect(existsSync(join(p.dir, "held", "2026-11-02-hhhhhh.json"))).toBe(true); expect(readFileSync(file, "utf8")).toBe("H");
  expect((await cues.list(p.dir))[0]).toMatchObject({ kind: "privacy", item: "2026-11-02-hhhhhh" });
});

test("purge removes only entries older than the retention, old-style entries included", async () => {
  const p = person(); const t = join(p.dir, ".trash");
  const now = Date.now(), day = 86_400_000;
  for (const [name, age] of [[`${now - 31 * day}-old-abcdef`, 31], [`${now - 29 * day}-young-abcdef`, 29], [`${now - 40 * day}-2026-10-01-legacy`, 40]] as const) mkdirSync(join(t, name), { recursive: true });
  expect(await quiet(async () => trash.purge(p.dir, 30, now))).toBe(2);
  expect(readdirSync(t)).toEqual([`${now - 29 * day}-young-abcdef`]);
});

// ── Duplicates ───────────────────────────────────────────────────────────────
test("links are written one way: pins by pin id, videos by video id, tracking dropped", () => {
  const n = dupes.normalizeUrl;
  expect(n("https://www.pinterest.com/pin/123456789/")).toBe("pinterest:123456789");
  expect(n("https://pinterest.co.uk/pin/spider-man-poster--123456789/?utm_source=x")).toBe("pinterest:123456789");
  expect(n("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("youtube:dQw4w9WgXcQ");
  expect(n("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")).toBe("youtube:dQw4w9WgXcQ");
  expect(n("https://www.instagram.com/p/Cxyz123/?igsh=1")).toBe("instagram:Cxyz123");
  expect(n("https://Example.com/a/?utm_medium=x&b=2&a=1#top")).toBe("example.com/a?a=1&b=2");
  expect(n("not a url")).toBeUndefined();
});

test("three saves of one picture are one group; the hand-placed copy is kept", () => {
  const p = person();
  page(p, "inspiration/2026-11-02-spider-1-aaaaaa", { files: [{ name: "web-1.jpg", data: "SAME" }], at: "2026-11-02T10:00:00Z" });
  page(p, "projects/2026-11-02-spider-2-bbbbbb", { files: [{ name: "web-1.jpg", data: "SAME" }], at: "2026-11-02T11:00:00Z", project: "zero-proof", placed: "2026-11-03T06:00:00Z" });
  page(p, "inspiration/2026-11-02-spider-3-cccccc", { files: [{ name: "web-1.jpg", data: "SAME" }], at: "2026-11-02T12:00:00Z" });
  page(p, "inspiration/2026-11-02-other-dddddd", { files: [{ name: "web-1.jpg", data: "DIFFERENT" }] });
  // Two different articles on one site share its preview picture: not copies.
  page(p, "links/2026-11-02-article-1-eeeeee", { url: "https://site.com/one", files: [{ name: "preview.jpg", data: "LOGO" }] });
  page(p, "links/2026-11-02-article-2-ffffff", { url: "https://site.com/two", files: [{ name: "preview.jpg", data: "LOGO" }] });
  // The same pin saved by link twice: copies.
  page(p, "links/2026-11-02-pin-1-gggggg", { url: "https://www.pinterest.com/pin/42/", at: "2026-11-01T09:00:00Z", saved: "2026-11-01" });
  page(p, "links/2026-11-02-pin-2-hhhhhh", { url: "https://pinterest.com/pin/nice--42/?utm_source=x" });
  dupes._test.reset();
  const groups = dupes.findDuplicates(p.dir, ROOT);
  expect(groups.length).toBe(2);
  const pics = groups.find((g) => g.same === "picture")!;
  expect(pics.items.map((x) => x.id)).toEqual(["inspiration/2026-11-02-spider-1-aaaaaa", "projects/2026-11-02-spider-2-bbbbbb", "inspiration/2026-11-02-spider-3-cccccc"]);
  expect(pics.keep).toBe("projects/2026-11-02-spider-2-bbbbbb");
  expect(pics.extras.sort()).toEqual(["inspiration/2026-11-02-spider-1-aaaaaa", "inspiration/2026-11-02-spider-3-cccccc"]);
  const pins = groups.find((g) => g.same === "link")!;
  expect(pins.keep).toBe("links/2026-11-02-pin-1-gggggg"); // nothing placed or in a project: the oldest
  expect(existsSync(join(p.dir, ".hashes.json"))).toBe(true);
});

test("duplicateOf at filing time sees a new job's files (absolute paths) and counts the copies", () => {
  const p = person();
  page(p, "inspiration/2026-11-02-spider-1-aaaaaa", { files: [{ name: "web-1.jpg", data: "PIN" }], at: "2026-11-02T10:00:00Z" });
  page(p, "inspiration/2026-11-02-spider-2-bbbbbb", { files: [{ name: "web-1.jpg", data: "PIN" }], at: "2026-11-02T11:00:00Z", project: "zero-proof" });
  const fresh = join(p.dir, "files", "2026-11-02-newnew", "web-1.jpg"); mkdirSync(dirname(fresh), { recursive: true }); writeFileSync(fresh, "PIN");
  expect(dupes.duplicateOf(p.dir, ROOT, [fresh])).toMatchObject({ id: "inspiration/2026-11-02-spider-2-bbbbbb", project: "zero-proof", count: 3 });
  expect(dupes.duplicateOf(p.dir, ROOT, [], "https://pinterest.com/pin/1/")).toBeUndefined();
  const cue = dupes.duplicateCue({ id: "x", count: 3 }, { title: "Spider", snippet: "", thumb: "a/web-1.jpg" });
  expect(cue.question).toBe("Same picture 3 times."); expect(cue.options.map((o) => o.id)).toEqual(["one", "all"]);
});

test("hashes are cached by size and modified time: ~500 pages rescan fast, and a changed file is re-read", () => {
  const p = person();
  for (let i = 0; i < 500; i++) page(p, `inspiration/2026-11-02-item-${i}-${String(i).padStart(6, "0")}`, { files: [{ name: "pic.jpg", data: new Uint8Array(20_000).fill(i % 250) }], url: `https://site.com/${i}` });
  dupes._test.reset();
  let t = performance.now(); const first = dupes.findDuplicates(p.dir, ROOT); const cold = performance.now() - t;
  dupes._test.reset(); // a restart: the hashes come back from .hashes.json
  t = performance.now(); dupes.findDuplicates(p.dir, ROOT); const warm = performance.now() - t;
  console.log(`500 pages: cold ${cold.toFixed(0)} ms, warm after restart ${warm.toFixed(0)} ms`);
  expect(first.length).toBe(250); // 500 pictures, 250 distinct fills (i % 250): pairs
  expect(warm).toBeLessThan(500);
  // Change one picture: it's re-hashed and its pair breaks up.
  const target = projects.scanPages(p.dir).find((it) => it.id.includes("item-0-"))!;
  const abs = join(ROOT, target.files[0]); writeFileSync(abs, "CHANGED"); utimesSync(abs, new Date(), new Date(Date.now() + 5000));
  expect(dupes.findDuplicates(p.dir, ROOT).length).toBe(249);
});

// ── Recent saves ─────────────────────────────────────────────────────────────
test("recent: filing, failed, waiting, filed and unsorted, newest first, with project names", async () => {
  const p = person();
  page(p, "projects/2026-11-02-in-project-aaaaaa", { project: "zero-proof", at: "2026-11-02T09:00:00Z", files: [{ name: "a.jpg", data: "A" }], notes: "for the bar" });
  page(p, "inspiration/2026-11-02-loose-bbbbbb", { at: "2026-11-02T10:00:00Z" });
  page(p, "inspiration/2026-11-02-asked-cccccc", { at: "2026-11-02T11:00:00Z" });
  page(p, "soul/rules", { at: "2026-11-02T23:00:00Z", app: true }); // never in the feed
  page(p, "writing/hand-made", { at: "2026-11-02T23:00:00Z" });     // not a save either
  page(p, "projects/2026-11-01-older-dddddd", { project: "zero-proof", saved: "2026-11-01", at: "2026-11-01T09:00:00Z" });
  await cues.add(p.dir, { kind: "project", item: "inspiration/2026-11-02-asked-cccccc", title: "Asked", snippet: "", question: "Which project is this for?", options: [] });
  await cues.add(p.dir, { kind: "when", item: "inspiration/2026-11-02-loose-bbbbbb", title: "Loose", snippet: "", question: "When?", options: [] }); // a reminder question isn't "waiting"
  const job = (folder: string, id: string, created: string, extra = {}) => { mkdirSync(join(p.dir, folder), { recursive: true }); writeFileSync(join(p.dir, folder, `${id}.json`), JSON.stringify({ id, notes: `note ${id}`, url: "", files: [], created, ...extra })); };
  job("inbox", "2026-11-02-fffff1", "2026-11-02T13:00:00Z", { files: [join(p.dir, "files/2026-11-02-fffff1/pic.jpg")] });
  job("inbox-failed", "2026-11-02-fffff2", "2026-11-02T12:30:00Z");
  job("held", "2026-11-02-fffff3", "2026-11-02T12:00:00Z");
  await cues.add(p.dir, { kind: "privacy", item: "2026-11-02-fffff3", title: "Looks personal", snippet: "", question: "This looks personal. Keep it private, or okay to share?", options: [] });
  job("inbox", "2026-11-02-aaaaaa", "2026-11-02T08:59:00Z"); // already filed as in-project-aaaaaa: shown once

  const r = await recent.recentFor(p, { root: ROOT, projects: [{ id: "zero-proof", name: "Zero Proof Lounge" }], limit: 12 });
  expect(r.items.map((x) => [x.id, x.status])).toEqual([
    ["pending:2026-11-02-fffff1", "filing"],
    ["pending:2026-11-02-fffff2", "failed"],
    ["pending:2026-11-02-fffff3", "waiting"],
    ["inspiration/2026-11-02-asked-cccccc", "waiting"],
    ["inspiration/2026-11-02-loose-bbbbbb", "unsorted"],
    ["projects/2026-11-02-in-project-aaaaaa", "filed"],
    ["projects/2026-11-01-older-dddddd", "filed"],
  ]);
  const filed = r.items.find((x) => x.id.includes("in-project"))!;
  expect(filed).toMatchObject({ project: "zero-proof", projectName: "Zero Proof Lounge", notes: "for the bar", saved_at: "2026-11-02T09:00:00.000Z" });
  expect(filed.thumb).toMatch(/^libraries\/p\d+\/files\/.+\/a\.jpg$/);
  expect(r.items[0].thumb).toBe(`libraries/${p.id}/files/2026-11-02-fffff1/pic.jpg`);
  expect(r.items[2]).toMatchObject({ title: "Looks personal", snippet: "This looks personal. Keep it private, or okay to share?" });
  expect(r.items[3].cue).toBeTruthy();
  expect(r.filing).toBe(2); expect(r.failed).toBe(1);
  expect((await recent.recentFor(p, { root: ROOT, projects: [], limit: 2 })).items.length).toBe(2);
});

// ── Routes ───────────────────────────────────────────────────────────────────
test("routes: delete → recent → undelete → duplicates/clean", async () => {
  const p = person(); const lib = fakeLib(p.dir);
  const a = page(p, "inspiration/2026-11-02-spider-1-aaaaaa", { files: [{ name: "web-1.jpg", data: "SAME" }], at: "2026-11-02T10:00:00Z" });
  const b = page(p, "inspiration/2026-11-02-spider-2-bbbbbb", { files: [{ name: "web-1.jpg", data: "SAME" }], at: "2026-11-02T11:00:00Z" });
  const withPerson = (fn: any) => (req: Request) => fn(req, p);
  const catalog = { version: 1, shelves: [], proposed: [], corrections: [], projects: [] };
  const routes: any = recent.findRoutes(withPerson, { root: ROOT, lib, invalidate: () => {}, loadCatalog: async () => catalog as any });
  const post = (path: string, body: unknown) => routes[path].POST(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }));

  const del = await quiet(() => post("/api/delete", { id: b.slug }));
  expect(del.status).toBe(200); const { undo } = await del.json();
  expect((await (await routes["/api/recent"](new Request("http://x/api/recent?limit=5"))).json()).items.map((x: any) => x.id)).toEqual([a.slug]);
  expect((await (await routes["/api/trash"](new Request("http://x/api/trash"))).json()).items[0].id).toBe(b.slug);
  expect((await quiet(() => post("/api/undelete", { undo }))).status).toBe(200);
  expect((await quiet(() => post("/api/undelete", { undo }))).status).toBe(404);
  expect((await post("/api/delete", {})).status).toBe(400);
  expect((await quiet(() => post("/api/delete", { id: "projects/missing-zzzzzz" }))).status).toBe(404);

  const groups = (await (await routes["/api/duplicates"](new Request("http://x/api/duplicates"))).json()).groups;
  expect(groups.length).toBe(1);
  const clean = await quiet(() => post("/api/duplicates/clean", { id: a.slug }));
  const c = await clean.json();
  expect(c.kept).toEqual([a.slug]); expect(c.deleted).toEqual([b.slug]); expect(c.undo).toBeTruthy();
  expect((await (await routes["/api/duplicates"](new Request("http://x/api/duplicates"))).json()).groups.length).toBe(0);
});
