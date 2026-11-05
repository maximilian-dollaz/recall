// cl boards-migrate [--dry-run]: turn the one team board (library/team-shares.json) into library/boards.json.
// The app does this by itself the first time it reads a board; this is for running it (or previewing it) by hand.
// Safe to run again: once boards.json exists it changes nothing. team-shares.json is never touched.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../app/paths.ts";
import { BOARDS, ensure, load, migrate } from "../app/board.ts";
import { peopleNow } from "../app/identity.ts";

const show = (f: ReturnType<typeof load>) => {
  for (const b of Object.values(f.boards)) {
    console.log(`${b.id}: "${b.name}", owner ${b.owner}`);
    console.log(`  members: ${Object.entries(b.members).map(([id, m]) => m.role === "owner" ? `${id} (owner)` : id).join(", ")}`);
    for (const [pid, bp] of Object.entries(b.projects)) console.log(`  ${pid}: ${Object.entries(bp.shares).map(([id, s]) => `${id} since ${s.since}`).join("; ")}`);
  }
};

if (Bun.argv.includes("--dry-run")) {
  if (existsSync(BOARDS)) { console.log(`${BOARDS} already exists; nothing would change.`); show(load()); }
  else { const shares = join(DATA, "library/team-shares.json"); show(migrate(existsSync(shares) ? JSON.parse(readFileSync(shares, "utf8")) : {}, peopleNow())); console.log("(dry run: nothing written)"); }
} else {
  console.log(ensure() ? `Made ${BOARDS}.` : `${BOARDS} already exists; nothing changed.`);
  show(load());
}
