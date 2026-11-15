// Fill a pool of signed shortcuts for a Recall server (see app/shortcut-pool.ts). Mac only: signing needs `shortcuts sign`.
//   bun tools/shortcut-pool.ts [--out <dir>] [--n 20]
// Keeps <dir>/<kind> topped up to n copies, each with its own new key, and writes the two shared camera shortcuts.
// `cl shortcut-pool` runs this, then copies the folder to the server.
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PUBLIC_URL } from "../app/config.ts";
import { POOL } from "../app/shortcut-pool.ts";

const arg = (k: string, d: string) => { const i = Bun.argv.indexOf(k); return i > 0 ? Bun.argv[i + 1] : d; };
const OUT = arg("--out", POOL), N = Number(arg("--n", "20"));
const CODE = join(import.meta.dir, "..");
const work = join(OUT, ".work"); mkdirSync(work, { recursive: true });

async function build(args: string[], dest: string) {
  const raw = join(work, "unsigned.shortcut"), signed = join(work, "signed.shortcut");
  const b = Bun.spawnSync(["python3", join(CODE, "shortcuts", args[0]), ...args.slice(1).map((a) => (a === "RAW" ? raw : a))]);
  if (b.exitCode !== 0) throw new Error(`build ${args[0]} failed: ${b.stderr}`);
  // Apple's signing service now and then refuses a request; wait and try again.
  for (let i = 0; i < 5 && !existsSync(signed); i++) {
    if (i) await Bun.sleep(5000 * i);
    Bun.spawnSync(["shortcuts", "sign", "--mode", "anyone", "-i", raw, "-o", signed]);
  }
  if (!existsSync(signed)) throw new Error(`signing failed for ${dest}`);
  renameSync(signed, dest);
}

const save = (key: string) => `${PUBLIC_URL}/k/${key}/api/save`;
const kinds: Record<string, (key: string) => string[]> = {
  iphone: (k) => ["build_share.py", save(k), "RAW", "iphone"],
  mac: (k) => ["build_share.py", save(k), "RAW", "mac"],
  "camera-save": (k) => ["build_camera.py", "save", "RAW", save(k)],
};
for (const [kind, args] of Object.entries(kinds)) {
  const dir = join(OUT, kind); mkdirSync(dir, { recursive: true });
  const have = readdirSync(dir).filter((n) => n.endsWith(".shortcut")).length;
  for (let i = have; i < N; i++) { const key = randomBytes(24).toString("base64url"); await build(args(key), join(dir, `${key}.shortcut`)); }
  console.log(`${kind}: ${Math.max(have, N)} (${Math.max(0, N - have)} new)`);
}
await build(["build_camera.py", "open", "RAW"], join(OUT, "camera-open.shortcut"));
await build(["build_camera.py", "recall", "RAW", `${PUBLIC_URL}/`], join(OUT, "camera-recall.shortcut"));
rmSync(work, { recursive: true, force: true });
console.log(`pool ready in ${OUT} for ${PUBLIC_URL}`);
