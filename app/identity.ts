// Who is asking? Phones on the private network are identified by Tailscale
// (each address belongs to a signed-in person). This Mac itself is the owner.
// Each person gets their own library (a GBrain source) and their own folders.

import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";

import { DATA as ROOT, CODE, TWIN } from "./paths.ts";
import { read, update } from "./store.ts";
import { OWNER_EMAIL, OWNER_NAME } from "./config.ts";
const slugId = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "owner";
export type Person = { id: string; name: string; email: string; source: string; dir: string };

const PEOPLE = join(ROOT, "library/people.json");
// alias_of: another login of the same person (Max has several Google accounts). Signing in with it opens the
// main account's library: put "alias_of": "<main email or person id>" on the extra account's entry.
export type Rec = { id: string; name: string; source?: string; welcomed?: boolean | Record<string, string>; picture?: string; alias_of?: string };
export type PeopleFile = { owner: string; people: Record<string, Rec> };
const FIRST: PeopleFile = { owner: OWNER_EMAIL, people: { [OWNER_EMAIL]: { id: slugId(OWNER_NAME), name: OWNER_NAME, source: "default" } } };

// A file that's there but unreadable is never treated as empty (that's how a torn write would wipe everyone):
// reads fall back to the owner alone for this request, and writes refuse until it's fixed.
export function peopleNow(): PeopleFile {
  try { return read<PeopleFile>(PEOPLE, structuredClone(FIRST)); } catch (e) { console.error(`[people] people.json unreadable: ${(e as Error).message}`); return structuredClone(FIRST); }
}
async function loadPeople(): Promise<PeopleFile> { return peopleNow(); }
const changePeople = (fn: (p: PeopleFile) => void) => update<PeopleFile>(PEOPLE, FIRST, (p) => { fn(p); });

/** The entry a login really belongs to, following alias_of (at most a few steps, never in a circle). */
export function resolveLogin(people: PeopleFile, email: string): { email: string; rec: Rec } | null {
  let e = email.trim().toLowerCase(); let rec = people.people[e]; if (!rec) return null;
  for (let hops = 0; rec.alias_of && hops < 4; hops++) {
    const to = rec.alias_of.trim().toLowerCase();
    const next = people.people[to] ? [to, people.people[to]] as const : Object.entries(people.people).find(([, r]) => r.id === to && !r.alias_of);
    if (!next || next[0] === e) break;
    [e, rec] = [next[0], next[1]];
  }
  return { email: e, rec };
}

// Tailscale address → login email, refreshed every minute.
let cache: { at: number; byIp: Map<string, string> } | null = null;
async function emailForIp(ip: string): Promise<string | null> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const byIp = new Map<string, string>();
    try {
      const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
      const s = JSON.parse(await new Response(p.stdout).text());
      const users: Record<string, string> = {};
      for (const [id, u] of Object.entries<any>(s.User ?? {})) users[id] = u.LoginName;
      for (const n of [s.Self, ...Object.values<any>(s.Peer ?? {})]) for (const addr of n?.TailscaleIPs ?? []) byIp.set(addr, users[String(n.UserID)] ?? "");
    } catch {}
    cache = { at: Date.now(), byIp };
  }
  return cache.byIp.get(ip) ?? null;
}

function personFor(email: string, rec: { id: string; name: string; source?: string }): Person {
  const source = rec.source ?? rec.id;
  const dir = source === "default" ? join(ROOT, "library") : join(ROOT, "libraries", rec.id);
  mkdirSync(join(dir, "files"), { recursive: true });
  return { id: rec.id, name: rec.name, email, source, dir };
}

/** Resolve the person behind a request. Local requests are the owner. Unknown phones get null. */
export async function whoIs(ip: string, override?: string | null): Promise<Person | null> {
  const local = ip === "127.0.0.1" || ip === "::1";
  // A login passed in by a trusted local front door (tailscale serve, the public door, or a test on this Mac).
  // A login nobody has used before gets its own new library, never the owner's.
  if (local && override) return personByEmail(override);
  const people = await loadPeople();
  if (local) return personFor(people.owner, people.people[people.owner]);
  const email = await emailForIp(ip);
  if (!email) return null;
  return personByEmail(email);
}

/** The person for a login, created (with their own library) the first time it's seen. */
export async function personByEmail(email: string, name?: string): Promise<Person> {
  email = email.trim().toLowerCase();
  const people = await loadPeople();
  const known = resolveLogin(people, email); // an alias opens the main account's library
  if (known) return personFor(known.email, known.rec);
  let id = (name ?? email.split("@")[0]).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 28) || "person";
  if (TWIN && !id.startsWith("twin")) id = `twin-${id}`.slice(0, 32); // the twin never shares a GBrain source with a real person
  const taken = new Set(Object.values(people.people).map((r) => r.id));
  for (let n = 2; taken.has(id) || id === "default"; n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  let rec: Rec = { id, name: name?.trim() || id.charAt(0).toUpperCase() + id.slice(1), source: id };
  await provision(id);
  await changePeople((fresh) => { rec = fresh.people[email] ??= rec; }); // re-read inside the lock: two first sign-ins at once both land
  return personFor(email, rec);
}

/** Every library and the person it belongs to. An alias's own (older) library counts as its main person's. */
export async function libraries(): Promise<{ id: string; dir: string; person: Person }[]> {
  const people = await loadPeople(); const seen = new Set<string>(); const out: { id: string; dir: string; person: Person }[] = [];
  for (const [email, rec] of Object.entries(people.people)) {
    if (seen.has(rec.id)) continue; seen.add(rec.id);
    const main = resolveLogin(people, email)!;
    out.push({ id: rec.id, dir: personFor(email, rec).dir, person: personFor(main.email, main.rec) });
  }
  return out;
}

/** A person by id (an alias's id gives its main person), or null. */
export async function personById(id: string): Promise<Person | null> {
  const people = await loadPeople();
  const hit = Object.entries(people.people).find(([, r]) => r.id === id); if (!hit) return null;
  const main = resolveLogin(people, hit[0])!; return personFor(main.email, main.rec);
}

/** Every entry's id → the id of the person it belongs to (a main account maps to itself). */
export function mainIds(): Map<string, string> {
  const people = peopleNow();
  return new Map(Object.entries(people.people).map(([email, rec]) => [rec.id, resolveLogin(people, email)!.rec.id]));
}

/** Remember a person's Google picture address (for their round avatar on team boards). */
export async function setPicture(email: string, url: string) {
  await changePeople((p) => { const r = p.people[email.trim().toLowerCase()]; if (r) r.picture = url; });
}

// A new teammate's library: their folder, a GBrain source for it, and the app's credential for that source.
// Runs once, the first time their phone opens the app. Nothing waits on Max.
const provisioning = new Map<string, Promise<void>>();
export function provision(id: string): Promise<void> {
  if (!provisioning.has(id)) provisioning.set(id, (async () => {
    const dir = join(ROOT, "libraries", id);
    mkdirSync(join(dir, "files"), { recursive: true });
    const env: Record<string, string | undefined> = { ...Bun.env, OLLAMA_BASE_URL: Bun.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1" };
    // `cl` routes gbrain through the server as a thin client (GBRAIN_HOME=cl-home). Adding a source needs the owner CLI.
    delete env.GBRAIN_HOME; delete env.GBRAIN_REMOTE_CLIENT_SECRET;
    const GB = Bun.which("gbrain") ?? join(Bun.env.HOME ?? "", ".bun/bin/gbrain");
    const run = async (cmd: string[]) => {
      if (cmd[0] === "gbrain") cmd = [GB, ...cmd.slice(1)];
      const p = Bun.spawn(cmd, { cwd: CODE, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
      if (code !== 0) { const e: any = new Error(`${cmd.slice(0, 3).join(" ")} failed: ${(err || out).trim().split("\n").pop()?.slice(0, 200)}`); e.detail = err + out; throw e; }
      return out;
    };
    if (!existsSync(join(dir, "README.md"))) await Bun.write(join(dir, "README.md"), `# ${id}'s library\n`);
    if (!existsSync(join(dir, ".git"))) await run(["git", "-C", dir, "init", "-q"]);
    await run(["git", "-C", dir, "add", "README.md"]);
    await run(["git", "-C", dir, "-c", "user.email=recall@local", "-c", "user.name=Recall", "commit", "-q", "-m", `${id}'s library`]).catch(() => {}); // already committed
    // Already registered (GBrain leaves an ownership marker in the folder): don't add it again.
    const registered = readdirSync(dir).some((f) => f.startsWith(".gbrain-owner"));
    // The CLI can't list sources while the server runs, so just add; "already registered" is fine.
    if (!registered) await run(["gbrain", "sources", "add", id, "--path", dir]).catch((e) => { if (!/source_id_taken|already registered/.test(e.message + (e.detail ?? ""))) throw e; });
    const creds = join(Bun.env.HOME ?? "", ".gbrain/serve/clients", `app-${id}.json`);
    if (!existsSync(creds)) await run(["gbrain", "mcp", "grant", `app-${id}`, "--harness", "generic", "--profile", "memory-writer", "--source", id, "--url", "http://127.0.0.1:3131/mcp", "--admin-token-file", join(Bun.env.HOME ?? "", ".gbrain/serve/admin-token"), "--credentials-out", creds]);
    console.log(`[provision] new library for ${id}`);
  })().catch((e) => { provisioning.delete(id); console.error(`[provision] ${id}: ${e.message}`); throw e; }));
  return provisioning.get(id)!;
}

export async function listPeople() { return loadPeople(); }

/** Whether a person has finished the welcome page (it adds the Recall shortcut), once per kind of device: a phone
 *  and a computer each need their own shortcut. `cl welcome-reset <email>` clears both for a test. */
export const deviceKind = (ua: string) => /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ? "phone" : "computer";
export function isWelcomed(rec: { welcomed?: boolean | Record<string, string> } | undefined, kind: string) {
  return !!rec && typeof rec.welcomed === "object" && !!rec.welcomed[kind];
}
export async function setWelcomed(email: string, welcomed = true, kind?: string) {
  let found = false;
  await changePeople((p) => {
    const rec = p.people[email.trim().toLowerCase()] as any; if (!rec) return; found = true;
    if (!welcomed) delete rec.welcomed;
    else { const done = typeof rec.welcomed === "object" ? rec.welcomed : {}; for (const k of kind ? [kind] : ["phone", "computer"]) done[k] = new Date().toISOString(); rec.welcomed = done; }
  });
  return found;
}
