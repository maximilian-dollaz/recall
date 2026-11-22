// Recall for Chrome as a .zip, built from extension/ each time it is asked for. extension/ is tracked in Git, so it
// ships with every deploy; a zip kept in dist/ is ignored by Git and never reached the server. Building it here means
// the download is always the code in extension/, with the version from its manifest.json.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const u16 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]);
const u32 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const cat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** A zip (files stored, not compressed: it is ~80 KB) of every file directly inside `dir`, all at the top level. */
export function zipFolder(dir: string): Uint8Array {
  const names = readdirSync(dir).filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isFile()).sort();
  const when = new Date(Math.max(...names.map((n) => statSync(join(dir, n)).mtimeMs)));
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const files: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const name of names) {
    const data = new Uint8Array(readFileSync(join(dir, name))), nm = new TextEncoder().encode(name), crc = Bun.hash.crc32(data);
    const common = [u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0)];
    const local = cat([u32(0x04034b50), ...common, nm, data]);
    central.push(cat([u32(0x02014b50), u16(20), ...common, u16(0), u16(0), u16(0), u32(0), u32(offset), nm]));
    files.push(local); offset += local.length;
  }
  const cd = cat(central);
  return cat([...files, cd, u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length), u32(cd.length), u32(offset), u16(0)]);
}

/** The extension's version, for the page and the file. */
export function extensionVersion(dir: string): string {
  try { return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version ?? ""; } catch { return ""; }
}
