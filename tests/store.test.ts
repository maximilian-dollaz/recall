// Safe JSON stores: many saves at once don't lose changes, a bad file is never replaced by an empty one,
// writes land whole, and files written by the old code still read. Everything runs in temp folders;
// RECALL_DATA points the app's data root there before any app module loads.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "recall-store-test-"));
process.env.RECALL_DATA = ROOT;
mkdirSync(join(ROOT, "library"), { recursive: true });

const store = await import("../app/store.ts");
const keys = await import("../app/keys.ts");
const librarian = await import("../app/librarian.ts");
const reminders = await import("../app/reminders.ts");
const cues = await import("../app/cues.ts");
const topics = await import("../app/topics.ts");
const { extractUrl } = await import("../app/extract.ts");
const { Vault } = await import("../app/vault.ts");

let n = 0;
const fresh = () => { const d = join(ROOT, `case-${++n}`); mkdirSync(d, { recursive: true }); return d; };
// The old code wrote every store like this; files on disk tonight look exactly so.
const oldWrite = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
const quiet = <T>(fn: () => Promise<T>) => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; return fn().finally(() => { console.error = e; console.warn = w; }); };

const CATALOG = join(ROOT, "library/categories.json");
const baseCatalog = () => ({ version: 1, shelves: [{ id: "reference", name: "Reference", type: "note", description: "facts" }], proposed: [], corrections: [], projects: [{ id: "elemental", name: "Elemental", aliases: [] }] });

beforeAll(() => { console.log(`temp data root: ${ROOT}`); });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ── store.ts ─────────────────────────────────────────────────────────────────
test("50 parallel increments to one file: none lost", async () => {
  const f = join(fresh(), "count.json");
  await Promise.all(Array.from({ length: 50 }, () => store.update<{ n: number }>(f, { n: 0 }, async (c) => { await Bun.sleep(Math.random() * 3); c.n++; })));
  expect(store.read(f, { n: -1 }).n).toBe(50);
});

test("a corrupt file throws, is left byte for byte, and later changes still run once it's fixed", async () => {
  const f = join(fresh(), "bad.json");
  writeFileSync(f, '{"rows": [1, 2,'); // torn mid-write
  expect(() => store.read(f, {})).toThrow();
  await expect(store.update(f, { rows: [] as number[] }, (c) => { c.rows.push(3); })).rejects.toThrow();
  expect(readFileSync(f, "utf8")).toBe('{"rows": [1, 2,');
  writeFileSync(f, '{"rows": [1, 2]}');
  await store.update<{ rows: number[] }>(f, { rows: [] }, (c) => { c.rows.push(3); });
  expect(store.read(f, { rows: [] as number[] }).rows).toEqual([1, 2, 3]);
});

test("a write that fails part-way leaves the old file whole and no temp files behind", async () => {
  const dir = fresh(), f = join(dir, "whole.json");
  store.writeNow(f, { ok: true });
  await expect(store.update<any>(f, {}, (c) => { c.big = 1n; })).rejects.toThrow(); // BigInt can't be written as JSON
  expect(store.read(f, {})).toEqual({ ok: true });
  for (let i = 0; i < 100; i++) await store.update<any>(f, {}, (c) => { c.i = i; });
  expect(readdirSync(dir)).toEqual(["whole.json"]);
});

test("a reader in another process never sees a half-written file", async () => {
  const dir = fresh(), f = join(dir, "big.json");
  const big = (k: number) => ({ k, rows: Array.from({ length: 4000 }, (_, i) => ({ i, text: "x".repeat(40 + (k % 7)) })) });
  store.writeNow(f, big(0));
  const reader = Bun.spawn([process.execPath, "-e", `
    const fs = require("node:fs"); let bad = 0, reads = 0; const end = Date.now() + 1500;
    while (Date.now() < end) { try { JSON.parse(fs.readFileSync(${JSON.stringify(f)}, "utf8")); } catch { bad++; } reads++; }
    console.log(JSON.stringify({ bad, reads }));`], { stdout: "pipe" });
  const until = Date.now() + 1400;
  for (let k = 1; Date.now() < until; k++) { await store.update(f, {}, () => big(k)); await Bun.sleep(0); }
  const { bad, reads } = JSON.parse(await new Response(reader.stdout).text());
  expect(reads).toBeGreaterThan(10);
  expect(bad).toBe(0);
});

// ── keys.ts ──────────────────────────────────────────────────────────────────
test("keys: an old keys.json still opens the door; parallel mints all land", async () => {
  const FILE = join(ROOT, "library/keys.json");
  const old = "old-key-from-last-week-abcdef";
  oldWrite(FILE, { [createHash("sha256").update(old).digest("hex")]: { email: "pat@example.com", created: "2026-10-30T10:00:00.000Z" } });
  expect(await keys.emailForKey(old)).toBe("pat@example.com");
  expect(await keys.emailForKey("nope-nope-nope-nope-nope")).toBeNull();
  const minted = await Promise.all(Array.from({ length: 20 }, (_, i) => keys.mintKey(`p${i}@example.com`)));
  for (const [i, k] of minted.entries()) expect(await keys.emailForKey(k)).toBe(`p${i}@example.com`);
  expect(await keys.emailForKey(old)).toBe("pat@example.com");
  const all = JSON.parse(readFileSync(FILE, "utf8"));
  expect(Object.keys(all).length).toBe(21);
  expect(all[createHash("sha256").update(old).digest("hex")].used).toBeTruthy(); // stamped on use
});

test("keys: a corrupt keys.json shuts the door and is never overwritten", async () => {
  const FILE = join(ROOT, "library/keys.json");
  const before = readFileSync(FILE, "utf8");
  writeFileSync(FILE, before.slice(0, 40));
  await quiet(async () => {
    expect(await keys.emailForKey("old-key-from-last-week-abcdef")).toBeNull();
    await expect(keys.mintKey("max@example.com")).rejects.toThrow();
  });
  expect(readFileSync(FILE, "utf8")).toBe(before.slice(0, 40));
  writeFileSync(FILE, before);
});

// ── librarian.ts: the catalog ────────────────────────────────────────────────
test("catalog: projects made at the same time are all kept", async () => {
  oldWrite(CATALOG, baseCatalog());
  expect((await librarian.loadCatalog()).projects!.map((p) => p.id)).toEqual(["elemental"]);
  await Promise.all(Array.from({ length: 25 }, (_, i) => librarian.updateCatalog((c) => { c.projects = [...(c.projects ?? []), { id: `p${i}`, name: `P${i}` }]; })));
  expect((await librarian.loadCatalog()).projects!.length).toBe(26);
});

test("catalog: updateCatalog returns what fn returns", async () => {
  const made = await librarian.updateCatalog((c) => { c.projects!.push({ id: "zero-proof", name: "Zero Proof" }); return c.projects!.length; });
  expect(made).toBe(27);
});

test("catalog: noteProposal on a copy read before a model call keeps projects made meanwhile", async () => {
  oldWrite(CATALOG, baseCatalog());
  const stale = await librarian.loadCatalog();                       // process() reads it, then waits on the model…
  await librarian.updateCatalog((c) => { c.projects!.push({ id: "frequency", name: "Frequency" }); }); // …someone makes a project
  await librarian.noteProposal(stale, "recipes", "reference/x", "a recipe");
  const now = await librarian.loadCatalog();
  expect(now.projects!.map((p) => p.id)).toEqual(["elemental", "frequency"]);
  expect(now.proposed.map((p) => p.name)).toEqual(["recipes"]);
  expect(stale.proposed.map((p) => p.name)).toEqual(["recipes"]); // the caller's copy is kept in step
});

test("catalog: corrupt or missing → loud error, file untouched", async () => {
  writeFileSync(CATALOG, '{"version": 1, "shelves": [');
  await quiet(async () => {
    await expect(librarian.loadCatalog()).rejects.toThrow();
    await expect(librarian.updateCatalog((c) => { c.corrections.push({ slug: "a", from: "b", to: "c", at: "now" }); })).rejects.toThrow();
    await expect(librarian.saveCatalog(baseCatalog() as any)).rejects.toThrow();
  });
  expect(readFileSync(CATALOG, "utf8")).toBe('{"version": 1, "shelves": [');
  rmSync(CATALOG);
  await quiet(async () => { await expect(librarian.loadCatalog()).rejects.toThrow(/missing/); await expect(librarian.updateCatalog(() => {})).rejects.toThrow(/missing/); });
  oldWrite(CATALOG, baseCatalog());
});

// ── reminders.ts ─────────────────────────────────────────────────────────────
test("reminders: old file reads; parallel adds and changes all land", async () => {
  const dir = fresh();
  oldWrite(join(dir, "reminders.json"), [{ id: "inspiration/old", title: "Old", summary: "", local: false, saved: "2026-10-01", due: "2026-10-15", state: "idea" }]);
  expect((await reminders.due(dir)).map((r) => r.id)).toEqual(["inspiration/old"]);
  await Promise.all(Array.from({ length: 30 }, (_, i) => reminders.addReminder(dir, { id: `x/${i}`, title: `${i}`, summary: "", local: false, saved: "2026-11-02", due: "2026-11-01" })));
  await Promise.all([reminders.setState(dir, "x/0", "done"), reminders.renameReminder(dir, "x/1", "y/1"), reminders.removeReminder(dir, "x/2")]);
  const rows = JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"));
  expect(rows.length).toBe(30);
  expect(rows.find((r: any) => r.id === "x/0").state).toBe("done");
  expect(rows.some((r: any) => r.id === "y/1")).toBe(true);
  expect(rows.some((r: any) => r.id === "x/2")).toBe(false);
});

test("reminders: changing something not there doesn't create a file", async () => {
  const dir = fresh();
  await reminders.removeReminder(dir, "nope"); await reminders.setState(dir, "nope", "done");
  expect(readdirSync(dir)).toEqual([]);
});

test("reminders: corrupt ledger → changes throw, nothing shows, file untouched", async () => {
  const dir = fresh(), f = join(dir, "reminders.json");
  writeFileSync(f, '[{"id": "a", "title"');
  await quiet(async () => {
    expect(await reminders.due(dir)).toEqual([]);
    await expect(reminders.addReminder(dir, { id: "b", title: "b", summary: "", local: false, saved: "2026-11-02", due: "2026-11-01" })).rejects.toThrow();
    await expect(reminders.removeReminder(dir, "a")).rejects.toThrow();
  });
  expect(readFileSync(f, "utf8")).toBe('[{"id": "a", "title"');
});

// ── cues.ts ──────────────────────────────────────────────────────────────────
const cue = (item: string) => ({ kind: "project" as const, item, title: item, snippet: "", question: "Which project is this for?", options: [{ id: "none", label: "No project" }] });

test("cues: old file reads; parallel adds land; two taps answer a card once", async () => {
  const dir = fresh();
  oldWrite(join(dir, "cues.json"), [{ id: "abc123", ...cue("old/item"), created: "2026-10-31T00:00:00.000Z" }]);
  expect((await cues.list(dir)).map((c) => c.id)).toEqual(["abc123"]);
  await Promise.all(Array.from({ length: 20 }, (_, i) => cues.add(dir, cue(`item/${i}`))));
  expect((await cues.list(dir)).length).toBe(21);
  const [a, b] = await Promise.all([cues.take(dir, "abc123"), cues.take(dir, "abc123")]);
  expect([a?.id, b?.id].filter(Boolean)).toEqual(["abc123"]);
  await cues.forget(dir, "item/3");
  expect((await cues.list(dir)).length).toBe(19);
});

test("cues: corrupt file → nothing shows, changes throw, file untouched", async () => {
  const dir = fresh(), f = join(dir, "cues.json");
  writeFileSync(f, "[{");
  await quiet(async () => {
    expect(await cues.list(dir)).toEqual([]);
    await expect(cues.add(dir, cue("x"))).rejects.toThrow();
    await expect(cues.take(dir, "x")).rejects.toThrow();
    await expect(cues.forget(dir, "x")).rejects.toThrow();
  });
  expect(readFileSync(f, "utf8")).toBe("[{");
});

// ── topics.ts ────────────────────────────────────────────────────────────────
test("topics: old topics.json reads; parallel renames and moves all land; corrupt is left alone", async () => {
  const dir = fresh(), f = join(dir, "topics.json");
  oldWrite(f, { v: 1, projects: { elemental: { topics: [{ id: "t1", name: "Lights", by: "librarian", created: "2026-10-30", members: ["a", "b", "c"] }, { id: "t2", name: "Chairs", by: "librarian", created: "2026-10-30", members: ["d", "e", "f"] }], loose: ["g", "h"], pinned: {} } } });
  const done = await Promise.all([topics.rename(dir, "elemental", "t1", "Lamps"), topics.move(dir, "elemental", "g", "t2"), topics.move(dir, "elemental", "h", "t1"), topics.rename(dir, "elemental", "nope", "X")]);
  expect(done).toEqual([true, true, true, false]);
  const st = JSON.parse(readFileSync(f, "utf8")).projects.elemental;
  expect(st.topics[0]).toMatchObject({ name: "Lamps", by: "person", members: ["a", "b", "c", "h"] });
  expect(st.topics[1].members).toEqual(["d", "e", "f", "g"]);
  expect(st.loose).toEqual([]);
  writeFileSync(f, '{"v":1,"projects":{');
  await quiet(async () => { await expect(topics.rename(dir, "elemental", "t1", "Y")).rejects.toThrow(); });
  expect(readFileSync(f, "utf8")).toBe('{"v":1,"projects":{');
});

// ── extract.ts ───────────────────────────────────────────────────────────────
test("extractUrl refuses addresses on this Mac or the home network, straight away", async () => {
  const t = Date.now();
  await expect(extractUrl("http://127.0.0.1:3345/api/shelves")).rejects.toThrow(/not a public/);
  await expect(extractUrl("http://localhost:3344/")).rejects.toThrow(/not a public/);
  await expect(extractUrl("http://192.168.1.1/")).rejects.toThrow(/not a public/);
  await expect(extractUrl("file:///etc/passwd")).rejects.toThrow(/not a public/);
  expect(Date.now() - t).toBeLessThan(5000);
});

// ── vault.ts ─────────────────────────────────────────────────────────────────
test("vault: a deleted item's words don't find the item that reuses its row, even in a vault made by the old code", () => {
  const dir = fresh();
  // The old schema: no delete trigger. Delete the newest row, then add one that reuses its rowid.
  const old = new Database(join(dir, "vault.sqlite"));
  old.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT, shelf TEXT, tags TEXT, summary TEXT, notes TEXT, body TEXT, files TEXT, created TEXT, state TEXT DEFAULT 'idea');
    CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, tags, summary, notes, body, content='items', content_rowid='rowid');
    CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, id, title, tags, summary, notes, body) VALUES (new.rowid, new.id, new.title, new.tags, new.summary, new.notes, new.body); END;`);
  const ins = old.query(`INSERT INTO items (id,title,shelf,tags,summary,notes,body,files,created) VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run("a", "zebra lamp", "x", "", "", "", "", "[]", "2026-11-01");
  ins.run("b", "walnut chair", "x", "", "", "", "", "[]", "2026-11-01");
  old.exec(`DELETE FROM items WHERE id = 'b'`);
  ins.run("c", "velvet sofa", "x", "", "", "", "", "[]", "2026-11-02");
  expect(old.query(`SELECT items.id FROM items_fts JOIN items ON items.rowid = items_fts.rowid WHERE items_fts MATCH 'walnut'`).all()).toEqual([{ id: "c" }]); // the bug
  old.close();
  const v = new Vault(dir);
  expect(v.search("walnut").strict).toEqual([]);
  expect(v.search("velvet").strict.map((x) => x.id)).toEqual(["c"]);
  const base = { shelf: "x", tags: [], summary: "", notes: "", body: "", files: [], created: "2026-11-02" };
  v.put({ id: "c", title: "green couch", ...base });
  v.delete("a"); v.put({ id: "d", title: "brass mirror", ...base });
  expect(v.search("velvet").strict).toEqual([]);
  expect(v.search("zebra").strict).toEqual([]);
  expect(v.search("couch").strict.map((x) => x.id)).toEqual(["c"]);
  expect(v.search("brass").strict.map((x) => x.id)).toEqual(["d"]);
});

test("cues: Clarify asks only what sorts a save (no reminder or duplicate cards)", async () => {
  const dir = fresh();
  await cues.add(dir, { ...cue("a"), kind: "when" as any });
  await cues.add(dir, { ...cue("b"), kind: "duplicate" as any });
  await cues.add(dir, cue("c"));
  expect((await cues.list(dir)).map((c) => c.item)).toEqual(["c"]);
});
