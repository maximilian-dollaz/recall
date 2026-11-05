// The vault: items marked "keep local". They never enter the GBrain library that
// Claude can reach. One vault per person: files under <their dir>/vault/ plus a
// small SQLite index with full-text search. Only this app reads it.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type VaultItem = { id: string; title: string; shelf: string; tags: string[]; summary: string; notes: string; body: string; files: string[]; created: string; state?: string };

const STOP = new Set(["a","an","the","and","or","of","to","for","in","on","at","about","with","my","our","is","it","that","this","what","i","me","we"]);
const open = new Map<string, Vault>();

export class Vault {
  db: Database; dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "vault.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, title TEXT, shelf TEXT, tags TEXT, summary TEXT, notes TEXT, body TEXT,
        files TEXT, created TEXT, state TEXT DEFAULT 'idea'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, tags, summary, notes, body, content='items', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, id, title, tags, summary, notes, body) VALUES (new.rowid, new.id, new.title, new.tags, new.summary, new.notes, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, id, title, tags, summary, notes, body) VALUES ('delete', old.rowid, old.id, old.title, old.tags, old.summary, old.notes, old.body);
        INSERT INTO items_fts(rowid, id, title, tags, summary, notes, body) VALUES (new.rowid, new.id, new.title, new.tags, new.summary, new.notes, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, id, title, tags, summary, notes, body) VALUES ('delete', old.rowid, old.id, old.title, old.tags, old.summary, old.notes, old.body);
      END;
    `);
    try { this.db.exec(`ALTER TABLE items ADD COLUMN state TEXT DEFAULT 'idea'`); } catch {}
    // Each write is one SQLite statement, so it lands whole or not at all. Before the delete trigger above,
    // deleted and replaced items stayed in the search index, and a new item reusing a row could be found by an
    // old one's words; rebuilding (small: one person's private items) clears that.
    this.db.exec(`PRAGMA busy_timeout = 5000; INSERT INTO items_fts(items_fts) VALUES ('rebuild');`);
  }
  private row(r: any): VaultItem { return { ...r, tags: r.tags ? r.tags.split(" ") : [], files: JSON.parse(r.files || "[]") }; }
  put(item: VaultItem) {
    // An upsert, not INSERT OR REPLACE: a replace deletes the row without the delete trigger, leaving its words in the index.
    this.db.query(`INSERT INTO items (id,title,shelf,tags,summary,notes,body,files,created,state) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, shelf=excluded.shelf, tags=excluded.tags, summary=excluded.summary, notes=excluded.notes,
        body=excluded.body, files=excluded.files, created=excluded.created, state=excluded.state`)
      .run(item.id, item.title, item.shelf, item.tags.join(" "), item.summary, item.notes, item.body, JSON.stringify(item.files), item.created, item.state ?? "idea");
  }
  get(id: string): VaultItem | null { const r = this.db.query(`SELECT * FROM items WHERE id = ?`).get(id); return r ? this.row(r) : null; }
  list(shelf?: string, limit = 100): VaultItem[] {
    const rows = shelf ? this.db.query(`SELECT * FROM items WHERE shelf = ? ORDER BY created DESC LIMIT ?`).all(shelf, limit)
      : this.db.query(`SELECT * FROM items ORDER BY created DESC LIMIT ?`).all(limit);
    return (rows as any[]).map((r) => this.row(r));
  }
  search(q: string, limit = 12): { strict: VaultItem[]; loose: VaultItem[] } {
    const words = q.replace(/["'()*]/g, " ").trim().split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase())).map((w) => `"${w}"*`);
    if (!words.length) return { strict: [], loose: [] };
    const run = (match: string, n: number) => (this.db.query(`SELECT items.* FROM items_fts JOIN items ON items.rowid = items_fts.rowid WHERE items_fts MATCH ? ORDER BY bm25(items_fts) LIMIT ?`).all(match, n) as any[]).map((r) => this.row(r));
    const strict = run(words.join(" AND "), limit);
    const seen = new Set(strict.map((v) => v.id));
    const loose = words.length > 1 ? run(words.join(" OR "), 3).filter((v) => !seen.has(v.id)) : [];
    return { strict, loose };
  }
  move(id: string, shelf: string) { this.db.query(`UPDATE items SET shelf = ? WHERE id = ?`).run(shelf, id); }
  setState(id: string, state: string) { this.db.query(`UPDATE items SET state = ? WHERE id = ?`).run(state, id); }
  delete(id: string) { this.db.query(`DELETE FROM items WHERE id = ?`).run(id); }
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.query(`SELECT shelf, COUNT(*) n FROM items GROUP BY shelf`).all() as any[]) out[r.shelf] = r.n;
    return out;
  }
}

/** The vault for a person's library folder (opened once per folder). */
export function vaultFor(personDir: string): Vault {
  const dir = join(personDir, "vault");
  let v = open.get(dir);
  if (!v) { v = new Vault(dir); open.set(dir, v); }
  return v;
}
