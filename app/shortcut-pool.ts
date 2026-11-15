// Signed shortcuts made ahead of time. Only a Mac can sign a shortcut (`shortcuts sign`), so a server
// can't build each person's own copy on the spot. Instead a Mac fills this folder (tools/shortcut-pool.ts),
// and the server hands out one copy per download and gives its key to that person (keys.ts claimKey).
//   library/shortcut-pool/<kind>/<key>.shortcut   one copy per person (iphone, mac, camera-save)
//   library/shortcut-pool/<kind>.shortcut         the same copy for everyone (camera-open, camera-recall)

import { join } from "node:path";
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { DATA as ROOT } from "./paths.ts";
import { claimKey } from "./keys.ts";

export const POOL = join(ROOT, "library/shortcut-pool");
export type Kind = "iphone" | "mac" | "camera-save" | "camera-open" | "camera-recall";
const SHARED: Kind[] = ["camera-open", "camera-recall"];

/** One signed shortcut of this kind for `email`, or null when the pool has run out. */
export async function take(kind: Kind, email: string): Promise<ArrayBuffer | null> {
  if (SHARED.includes(kind)) { const f = join(POOL, `${kind}.shortcut`); return existsSync(f) ? Bun.file(f).arrayBuffer() : null; }
  const dir = join(POOL, kind);
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => /^[A-Za-z0-9_-]{20,64}\.shortcut$/.test(n)) : [];
  for (const name of files) {
    // Moving it first means two downloads at once can never get the same key.
    const mine = join(dir, `${name}.taken-${process.pid}-${Date.now()}`);
    try { renameSync(join(dir, name), mine); } catch { continue; }
    const bytes = await Bun.file(mine).arrayBuffer();
    await claimKey(name.replace(/\.shortcut$/, ""), email);
    unlinkSync(mine);
    if (files.length <= 5) console.error(`[shortcut pool] ${kind}: ${files.length - 1} left. Refill from the Mac: cl shortcut-pool`);
    return bytes;
  }
  console.error(`[shortcut pool] ${kind} is empty. Refill from the Mac: cl shortcut-pool`);
  return null;
}

/** How many of each kind are left (for status). */
export function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["iphone", "mac", "camera-save"]) { const d = join(POOL, k); out[k] = existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(".shortcut")).length : 0; }
  for (const k of SHARED) out[k] = existsSync(join(POOL, `${k}.shortcut`)) ? 1 : 0;
  return out;
}
