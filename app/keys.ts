// Phone keys: how a person's own shortcut saves through the public door with no browser cookie.
// Each download of "Share to Recall" carries a fresh key for that person, built into their copy.
// Keys are stored hashed, like invite tokens and sessions, so the file on disk can't be used to get in.
// A key can only save (POST /k/<key>/api/save); it can't read anything.

import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DATA as ROOT } from "./paths.ts";
import * as store from "./store.ts";

const FILE = join(ROOT, "library/keys.json");
type Key = { email: string; created: string; used?: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// A keys.json that can't be read is left exactly as it is and said out loud; it is never replaced by an empty one.
const say = (e: any) => console.error(`[keys] ${FILE} left untouched: ${e?.message ?? e}`);
const loud = (e: any): never => { say(e); throw e; };

export async function mintKey(email: string): Promise<string> {
  const key = randomBytes(24).toString("base64url");
  await store.update<Record<string, Key>>(FILE, {}, (all) => { all[hash(key)] = { email, created: new Date().toISOString() }; }).catch(loud);
  return key;
}

export async function emailForKey(key: string): Promise<string | null> {
  const h = hash(key);
  let row: Key | undefined;
  try { row = store.read<Record<string, Key>>(FILE, {})[h]; } catch (e) { say(e); return null; } // unreadable: the door stays shut
  if (!row) return null;
  const today = new Date().toISOString().slice(0, 10);
  // "Last used" is a nicety: stamped once a day, on a fresh read, and a failure never blocks the save.
  if (row.used?.slice(0, 10) !== today) await store.update<Record<string, Key>>(FILE, {}, (all) => { if (all[h]) all[h].used = new Date().toISOString(); }).catch(() => {});
  return row.email;
}
