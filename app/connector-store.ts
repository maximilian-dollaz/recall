// Where connectors keep what must stay private: install keys and each person's sign-ins.
// Keys the owner pastes once (Metricool, Canva, the Google client secret) sit beside the other service keys:
// ~/.gbrain/serve/<name>.key. A person's sign-in to a service (Drive, Canva) sits where meetings.ts keeps
// Granola's and Otter's: ~/.gbrain/serve/connectors/<person>/<service>.json. Both are outside every library
// (never in git or GBrain), owner-only (600), and nothing here logs or returns a secret.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, TWIN } from "./paths.ts";

// Read on every call (not once at load), so a key pasted while the app runs counts at once and tests can point elsewhere.
const keysDir = () => Bun.env.RECALL_KEYS_DIR ?? join(Bun.env.HOME ?? "", ".gbrain/serve");
const connectorsDir = () => Bun.env.RECALL_CONNECTORS ?? (TWIN ? join(DATA, "connectors") : join(Bun.env.HOME ?? "", ".gbrain/serve/connectors"));

/** An install key's text, or "" when it isn't saved. */
export function key(name: string): string { try { return readFileSync(join(keysDir(), `${name}.key`), "utf8").trim(); } catch { return ""; } }
/** When a key was saved (never the key). */
export function keySavedAt(name: string): string | undefined { try { return new Date(statSync(join(keysDir(), `${name}.key`)).mtimeMs).toISOString(); } catch { return undefined; } }

const file = (pid: string, service: string) => join(connectorsDir(), pid.replace(/[^a-z0-9_-]/gi, "_"), `${service}.json`);

/** One person's sign-in to one service. Missing or unreadable reads as not connected. */
export function read<T extends object>(pid: string, service: string): Partial<T> { try { return JSON.parse(readFileSync(file(pid, service), "utf8")); } catch { return {}; } }
/** Written whole (temp file, then rename), owner-only. */
export function write(pid: string, service: string, value: object) {
  const f = file(pid, service); mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, f);
}
export function patch<T extends object>(pid: string, service: string, fn: (s: Partial<T>) => void): Partial<T> { const s = read<T>(pid, service); fn(s); write(pid, service, s); return s; }
export function remove(pid: string, service: string) { rmSync(file(pid, service), { force: true }); }
export const has = (pid: string, service: string) => existsSync(file(pid, service));
export const pathOf = file;
