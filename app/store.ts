// Safe JSON files. Every small store (people, sessions, keys, shares, the catalog, reminders, cues, boards) goes
// through here: one change at a time per file, read fresh inside the lock, never overwritten from a bad read,
// written whole (temp file, then rename) so a crash or two saves at once can't leave a torn file.

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const chains = new Map<string, Promise<unknown>>();

/** Read a JSON file. Missing → the fallback. Present but unreadable → throws (never treated as empty). */
export function read<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return fallback;
  try { return JSON.parse(text) as T; } catch (e: any) { throw new Error(`${path} is not valid JSON (left as is): ${e.message}`); } // never replaced by an empty one
}

/** Write a JSON file whole: temp file, then rename. */
export function writeNow(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Change a JSON file safely: changes to one file run one after another, each on a fresh read.
 *  `fn` gets the current value (or the fallback when the file doesn't exist) and returns the new value
 *  (or mutates it and returns nothing). Resolves to what was written. */
export function update<T>(path: string, fallback: T, fn: (cur: T) => T | void | Promise<T | void>): Promise<T> {
  const run = (chains.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const cur = read<T>(path, structuredClone(fallback));
    const next = (await fn(cur)) ?? cur;
    writeNow(path, next);
    return next as T;
  });
  chains.set(path, run);
  return run;
}
