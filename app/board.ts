// Team boards: projects people chose to share, with everyone's saves in them, on one screen.
//
// A board is a tree. Trunk: the board (True Nature Media). Then the team's projects (Frequency, Zero Proof),
// and inside each one, each person's own project with their name and picture, then topics, then the saves.
// Sharing is live: a shared project *is* the person's project, read from their own pages every time, never copied.
// The same project shared by several people (Max's Zero Proof, a teammate's Zero Proof) is one panel; `from` lets
// someone's own project feed a board project with another name.
//
// Only members see a board. The owner adds and removes members and makes invites (one use, seven days);
// members share and unshare their own projects. Private (vault) saves are never in a project, so never here.
// Only files on a board the person can see can be fetched through it.
//
// Store: library/boards.json (see BoardsFile). Before boards there was one team board in team-shares.json:
// the first load turns that into the board "True Nature Media" and leaves the old file as it was.

import { join, extname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DATA as ROOT } from "./paths.ts";
import { libraries, mainIds, peopleNow, type PeopleFile } from "./identity.ts";
import { scanPages, projectsOf, type Project, type ProjectItem } from "./projects.ts";
import { reconcile, type TopicView } from "./topics.ts";
import { read, update, writeNow } from "./store.ts";
import type { Catalog } from "./librarian.ts";
import { TEAM_ID, TEAM_NAME } from "./config.ts";

export type Post = { id: string; person: string; who: string; notes: string; title: string; files: string[]; saved: string; batch: string; pending: boolean; item: ProjectItem };

// ── The store ──────────────────────────────────────────────────────────────────
type Member = { role: "owner" | "member"; added: string; by: string };
type Invite = { email?: string; created: string; expires: string; maxUses: number; uses: number; by: string; usedBy?: string[] };
type Share = { since: string; from: string };            // from: the person's own project that feeds this one
type BoardProject = { added: string; by: string; shares: Record<string, Share> };
type Pin = { person: string; slug: string; by: string; at: string };
export type Board = {
  id: string; name: string; owner: string; created: string;
  members: Record<string, Member>;
  invites: Record<string, Invite>;                      // keyed by sha256 of the token; the token itself is never stored
  projects: Record<string, BoardProject>;
  pins: Pin[];                                          // someone else's save dragged out onto the board
  hidden: string[];                                     // "<personId>:<slug>" the owner took off the board
};
export type BoardsFile = { version: 2; default: string; boards: Record<string, Board> };

export const BOARDS = join(ROOT, "library/boards.json");
const SHARES = join(ROOT, "library/team-shares.json"); // the one team board, before boards; read once, never written
const SETTINGS = join(ROOT, "library/settings.json");
export const DEFAULT = TEAM_ID;
export const TEAM_DIR = join(ROOT, "library/team-board"); // the default board's topics (kept from before boards)
const EMPTY: BoardsFile = { version: 2, default: DEFAULT, boards: {} };
const WEEK = 7 * 24 * 3600_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

type OldShares = Record<string, Record<string, { since: string }>>;
/** Today's single team board (team-shares.json) as the first board. Pure, so it can be tested and rerun. */
export function migrate(shares: OldShares, people: PeopleFile, at = now()): BoardsFile {
  const owner = people.people[people.owner]?.id ?? "owner";
  const members: Record<string, Member> = { [owner]: { role: "owner", added: at, by: owner } };
  // Everyone who has signed in (each entry in people.json was made by a first sign-in) and everyone who shares.
  for (const rec of Object.values(people.people)) members[rec.id] ??= { role: "member", added: at, by: "migration" };
  const projects: Record<string, BoardProject> = {};
  for (const [pid, by] of Object.entries(shares)) {
    const list = Object.entries(by ?? {}).filter(([, s]) => s?.since).sort((a, b) => a[1].since.localeCompare(b[1].since));
    if (!list.length) continue;
    for (const [person] of list) members[person] ??= { role: "member", added: at, by: "migration" };
    projects[pid] = { added: list[0][1].since, by: list[0][0], shares: Object.fromEntries(list.map(([person, s]) => [person, { since: s.since, from: pid }])) };
  }
  return { version: 2, default: DEFAULT, boards: { [DEFAULT]: { id: DEFAULT, name: TEAM_NAME, owner, created: at, members, invites: {}, projects, pins: [], hidden: [] } } };
}

/** Make boards.json from team-shares.json the first time. Does nothing once it exists. */
export function ensure(): boolean {
  if (existsSync(BOARDS)) return false;
  // An unreadable team-shares.json throws here: better no board than a board that silently lost every share.
  writeNow(BOARDS, migrate(read<OldShares>(SHARES, {}), peopleNow()));
  console.log(`[boards] made ${BOARDS.replace(ROOT + "/", "")} from team-shares.json`);
  return true;
}
export function load(): BoardsFile { ensure(); return read<BoardsFile>(BOARDS, structuredClone(EMPTY)); }
async function change<T>(fn: (f: BoardsFile) => T): Promise<T> {
  ensure(); let out!: T;
  await update<BoardsFile>(BOARDS, EMPTY, (f) => { out = fn(f); });
  invalidate(); return out;
}
export const defaultId = () => load().default || DEFAULT;
export function getBoard(id: string): Board | null { return load().boards[id] ?? null; }

// ── Who may do what ────────────────────────────────────────────────────────────
// Membership is by person. An alias (another login of the same person) counts as its main person.
function roleIn(b: Board, personId: string, main = mainIds()): Member["role"] | null {
  let role: Member["role"] | null = null;
  for (const [id, m] of Object.entries(b.members)) if ((main.get(id) ?? id) === personId) { if (m.role === "owner") return "owner"; role = m.role; }
  return role;
}
export function canSee(personId: string, boardId: string): boolean { const b = getBoard(boardId); return !!b && !!roleIn(b, personId); }
/** The owner runs the board: members, invites, hiding. */
export function canEdit(personId: string, boardId: string): boolean { const b = getBoard(boardId); return !!b && roleIn(b, personId) === "owner"; }
export function boardsFor(personId: string): Board[] { const main = mainIds(); return Object.values(load().boards).filter((b) => roleIn(b, personId, main)); }
/** Two people share at least one board (so one may see the other's picture). */
export function sharesBoard(a: string, b: string): boolean { if (a === b) return true; const main = mainIds(); return Object.values(load().boards).some((x) => roleIn(x, a, main) && roleIn(x, b, main)); }

// ── Boards, members, invites ───────────────────────────────────────────────────
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "board";
export async function createBoard(name: string, owner: string): Promise<Board> {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 60); if (!clean) throw new Error("A board needs a name.");
  return change((f) => {
    let id = slugify(clean); for (let n = 2; f.boards[id]; n++) id = `${slugify(clean).slice(0, 36)}-${n}`;
    const b: Board = { id, name: clean, owner, created: now(), members: { [owner]: { role: "owner", added: now(), by: owner } }, invites: {}, projects: {}, pins: [], hidden: [] };
    f.boards[id] = b; return b;
  });
}
export async function addMember(boardId: string, personId: string, by: string): Promise<boolean> {
  return change((f) => {
    const b = f.boards[boardId]; if (!b) return false;
    if (!roleIn(b, personId)) b.members[personId] = { role: "member", added: now(), by };
    return true;
  });
}
/** Take someone off a board, and their shares with them. The owner can't be removed. */
export async function removeMember(boardId: string, personId: string): Promise<boolean> {
  return change((f) => {
    const b = f.boards[boardId]; if (!b) return false;
    const main = mainIds(); const theirs = Object.keys(b.members).filter((id) => (main.get(id) ?? id) === personId);
    if (!theirs.length || theirs.some((id) => b.members[id].role === "owner")) return false;
    for (const id of theirs) delete b.members[id];
    for (const [pid, bp] of Object.entries(b.projects)) { for (const id of theirs) delete bp.shares[id]; if (!Object.keys(bp.shares).length) delete b.projects[pid]; }
    b.pins = b.pins.filter((p) => !theirs.includes(p.by) && !theirs.includes(p.person));
    return true;
  });
}

/** A one-use link to join a board, good for seven days. Returns the token (shown once, stored hashed). */
export async function createInvite(boardId: string, by: string, email?: string): Promise<{ token: string; expires: string } | null> {
  const token = randomBytes(24).toString("base64url"); const expires = new Date(Date.now() + WEEK).toISOString();
  const ok = await change((f) => {
    const b = f.boards[boardId]; if (!b) return false;
    for (const [h, inv] of Object.entries(b.invites)) if (inv.expires < now()) delete b.invites[h]; // tidy expired ones
    b.invites[hash(token)] = { ...(email ? { email: email.trim().toLowerCase() } : {}), created: now(), expires, maxUses: 1, uses: 0, by };
    return true;
  });
  return ok ? { token, expires } : null;
}
/** What an invite link opens, if it still works. */
export function inviteInfo(token: string): { board: Board; invite: Invite } | null {
  const h = hash(token);
  for (const b of Object.values(load().boards)) { const inv = b.invites[h]; if (inv && inv.expires > now() && inv.uses < inv.maxUses) return { board: b, invite: inv }; }
  return null;
}
/** Join a board with an invite. Already a member: nothing is spent. Returns the board id, or null. */
export async function acceptInvite(token: string, personId: string): Promise<{ board: string; joined: boolean } | null> {
  const h = hash(token);
  return change((f) => {
    for (const b of Object.values(f.boards)) {
      const inv = b.invites[h]; if (!inv) continue;
      if (roleIn(b, personId)) return { board: b.id, joined: false };
      if (inv.expires <= now() || inv.uses >= inv.maxUses) return null;
      inv.uses += 1; (inv.usedBy ??= []).push(personId);
      b.members[personId] = { role: "member", added: now(), by: inv.by };
      return { board: b.id, joined: true };
    }
    return null;
  });
}

// ── Sharing ────────────────────────────────────────────────────────────────────
// The switch (library/settings.json, "autoShareTeamProjects"): when on, projects marked team (the two lounges)
// are on the default board for every member who saves into them, with no Share click.
export function autoShareTeam(): boolean { try { return !!JSON.parse(readFileSync(SETTINGS, "utf8")).autoShareTeamProjects; } catch { return false; } }
const teamIds = (catalog: Catalog) => new Set(autoShareTeam() ? projectsOf(catalog).filter((p) => p.team).map((p) => p.id) : []);
export function alwaysShared(catalog: Catalog, projectId: string) { return teamIds(catalog).has(projectId); }

/** Whether a person's own project is on a board (by default the team board). */
export function isShared(projectId: string, personId: string, catalog?: Catalog, boardId = defaultId()) {
  const b = getBoard(boardId); if (!b) return false;
  const main = mainIds(); const mine = (id: string) => (main.get(id) ?? id) === personId;
  if (Object.values(b.projects).some((bp) => Object.entries(bp.shares).some(([id, s]) => mine(id) && s.from === projectId))) return true;
  return !!catalog && boardId === defaultId() && alwaysShared(catalog, projectId) && !!roleIn(b, personId, main);
}
/** Share (or stop sharing) a person's own project `from` into the board's project `projectId`. Members only. */
export async function setShared(projectId: string, personId: string, on: boolean, boardId = defaultId(), from = projectId): Promise<boolean> {
  return change((f) => {
    const b = f.boards[boardId]; if (!b || !roleIn(b, personId)) return false;
    if (on) {
      const bp = b.projects[projectId] ??= { added: now(), by: personId, shares: {} };
      bp.shares[personId] = { since: bp.shares[personId]?.since ?? now(), from };
    } else {
      // Stopping: by the board project, or (from a person's own project page) wherever that project feeds.
      const main = mainIds();
      for (const [pid, bp] of Object.entries(b.projects)) {
        for (const [id, s] of Object.entries(bp.shares)) if ((main.get(id) ?? id) === personId && (pid === projectId || s.from === projectId)) delete bp.shares[id];
        if (!Object.keys(bp.shares).length) delete b.projects[pid];
      }
    }
    return true;
  });
}
/** The owner takes one save off the board (it stays in its person's library), or puts it back. */
export async function setHidden(boardId: string, item: string, hidden: boolean) {
  return change((f) => { const b = f.boards[boardId]; if (!b) return false; b.hidden = b.hidden.filter((x) => x !== item); if (hidden) b.hidden.push(item); return true; });
}
/** A member drags a save that's on the board out onto the board itself. Nobody writes into another person's library. */
export async function setPinned(boardId: string, item: string, by: string, on: boolean) {
  const [person, ...rest] = item.split(":"); const slug = rest.join(":"); if (!person || !slug) return false;
  return change((f) => {
    const b = f.boards[boardId]; if (!b) return false;
    b.pins = b.pins.filter((p) => !(p.person === person && p.slug === slug));
    if (on) b.pins.push({ person, slug, by, at: now() });
    return true;
  });
}

/** Projects on a board, in the order they were first shared (positions stay put). Team projects lead. */
export function teamProjects(catalog: Catalog, boardId = defaultId()): Project[] {
  const b = getBoard(boardId); if (!b) return [];
  const known = new Map(projectsOf(catalog).map((p) => [p.id, p]));
  const always = boardId === defaultId() ? teamIds(catalog) : new Set<string>();
  const first = (id: string) => always.has(id) ? "" : b.projects[id]?.added ?? "";
  const ids = [...new Set([...always, ...Object.keys(b.projects).filter((id) => Object.keys(b.projects[id].shares).length)])];
  return ids.sort((a, c) => first(a).localeCompare(first(c)))
    .map((id) => known.get(id) ?? { id, name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) });
}

// ── Reading a board ────────────────────────────────────────────────────────────
const VISUAL = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
export const AVATARS = join(ROOT, "library/avatars");
export const avatarUrl = (personId: string) => existsSync(join(AVATARS, `${personId}.jpg`)) ? `/avatar/${encodeURIComponent(personId)}` : null;
type Collected = { at: number; byProject: Map<string, Post[]>; allowed: Set<string>; pins: Post[]; names: Map<string, string> };
const cache = new Map<string, Collected>();
export function invalidate() { cache.clear(); }

async function collect(catalog: Catalog, boardId: string): Promise<Collected> {
  const hit = cache.get(boardId); if (hit && Date.now() - hit.at < 10_000) return hit;
  const b = getBoard(boardId);
  const byProject = new Map<string, Post[]>(teamProjects(catalog, boardId).map((p) => [p.id, []]));
  const allowed = new Set<string>(); const names = new Map<string, string>(); const all = new Map<string, Post>();
  const always = boardId === defaultId() ? teamIds(catalog) : new Set<string>();
  const hidden = new Set(b?.hidden ?? []); const main = mainIds();
  for (const lib of b ? await libraries() : []) {
    const person = lib.person; if (!roleIn(b!, person.id, main)) continue; // only members are on a board
    names.set(person.id, person.name);
    // Which of this library's projects feed which board projects. A share is the person's, whichever of their
    // logins made it, so it covers all their libraries (an alias's older one too).
    const feeds = new Map<string, Set<string>>(); const feed = (own: string, to: string) => { if (!feeds.has(own)) feeds.set(own, new Set()); feeds.get(own)!.add(to); };
    for (const [pid, bp] of Object.entries(b!.projects)) for (const [id, s] of Object.entries(bp.shares)) if ((main.get(id) ?? id) === person.id) feed(s.from, pid);
    for (const id of always) feed(id, id);
    if (!feeds.size) continue;
    for (const it of scanPages(lib.dir)) {
      const to = it.project ? feeds.get(it.project) : undefined; if (!to) continue;
      const id = `${lib.id}:${it.id}`; if (hidden.has(id)) continue;
      const post: Post = { id, person: person.id, who: person.name, notes: it.notes ?? "", title: it.title, files: it.files, saved: it.saved, batch: it.batch ?? it.id, pending: false, item: { ...it, id, by: person.name, person: person.id } as ProjectItem };
      for (const pid of to) byProject.get(pid)?.push(post);
      all.set(id, post); it.files.forEach((f) => allowed.add(f));
    }
    // Saves still being filed that already know their project (the person named it): on the board at once,
    // marked pending, so a save shows the moment it lands instead of a minute later.
    let inbox: string[] = []; try { inbox = readdirSync(join(lib.dir, "inbox")).filter((n) => n.endsWith(".json")); } catch {}
    for (const n of inbox) {
      let job: any; try { job = JSON.parse(readFileSync(join(lib.dir, "inbox", n), "utf8")); } catch { continue; }
      const to = job.project && !job.keepLocal ? feeds.get(job.project) : undefined; if (!to) continue;
      const files = (job.files ?? []).map((f: string) => f.replace(ROOT + "/", "")), id = `${lib.id}:pending:${job.id}`;
      const it = { id, title: String(job.title || job.notes || "Being filed…").slice(0, 80), kind: files.some((f: string) => /\.(png|jpe?g|gif|webp|heic)$/i.test(f)) ? "image" : job.url ? "link" : "note",
        thumb: files.find((f: string) => /\.(png|jpe?g|gif|webp|heic)$/i.test(f)), summary: "", saved: String(job.created ?? "").slice(0, 10), project: job.project, url: job.url || undefined, files, notes: job.notes, by: person.name, person: person.id, tags: [], pending: true } as any;
      const post: Post = { id, person: person.id, who: person.name, notes: job.notes ?? "", title: it.title, files, saved: it.saved, batch: job.batch ?? job.id, pending: true, item: it };
      for (const pid of to) byProject.get(pid)?.push(post);
      all.set(id, post); files.forEach((f: string) => allowed.add(f));
    }
  }
  // Pins show only while their save is still on the board: unsharing takes them away too.
  const pins = (b?.pins ?? []).map((p) => all.get(`${p.person}:${p.slug}`)).filter(Boolean) as Post[];
  const c = { at: Date.now(), byProject, allowed, pins, names };
  cache.set(boardId, c); return c;
}

const countKinds = (items: ProjectItem[]) => { const counts: Record<string, number> = {}; for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1; return counts; };
/** Who is in a project on the board: each person once, with their picture and how many saves are theirs. */
function contributors(posts: Post[], b: Board | null, projectId: string) {
  const by = new Map<string, { id: string; name: string; avatar: string | null; count: number; since: string }>();
  const main = mainIds(); const since = (pid: string) => Object.entries(b?.projects[projectId]?.shares ?? {}).filter(([id]) => (main.get(id) ?? id) === pid).map(([, s]) => s.since).sort()[0] ?? "";
  for (const p of posts) { const r = by.get(p.person) ?? { id: p.person, name: p.who, avatar: avatarUrl(p.person), count: 0, since: since(p.person) }; r.count++; by.set(p.person, r); }
  // In the order they joined the project (so nobody's group jumps around), then by name.
  return [...by.values()].sort((a, c) => (a.since || "~").localeCompare(c.since || "~") || a.name.localeCompare(c.name));
}

/** The board's panels: every shared project, with a few pictures and counts (same shape as a person's own projects). */
export async function teamPanels(catalog: Catalog, boardId = defaultId()) {
  const { byProject } = await collect(catalog, boardId); const b = getBoard(boardId);
  return teamProjects(catalog, boardId).map((p) => {
    const posts = byProject.get(p.id) ?? []; const items = posts.map((x) => x.item);
    const newest = (it: ProjectItem) => it.placed ?? it.saved; // placed by hand counts from when it was placed, as on the person's own panel
    const pics = items.filter((it) => it.thumb).sort((a, c) => newest(c).localeCompare(newest(a)));
    const who = contributors(posts, b, p.id);
    return { id: p.id, name: p.name, count: items.length, thumbs: pics.slice(0, 12).map((it) => it.thumb!), counts: countKinds(items), people: who.map((x) => x.name), contributors: who.map(({ since: _, ...x }) => x) };
  });
}
/** Saves dragged out onto the board itself. */
export async function boardPins(catalog: Catalog, boardId = defaultId()) { return (await collect(catalog, boardId)).pins.map((p) => p.item); }

/** Where a board keeps its topics (the default board keeps the folder it had before boards). */
export const boardDir = (boardId: string) => boardId === defaultId() ? TEAM_DIR : join(ROOT, "library/boards", boardId.replace(/[^a-z0-9-]/g, ""));

/** Keep only one person's items in a topic tree (empty topics drop out). */
function only(groups: TopicView[], keep: Set<string>): TopicView[] {
  return groups.map((g) => {
    const children = g.children ? only(g.children, keep) : undefined;
    return { ...g, items: g.items.filter((i) => keep.has(i)), ...(children ? { children } : {}) };
  }).filter((g) => g.items.length);
}

/** One shared project, opened: the topics formed from everyone's items together, and each person's own
 *  contribution as its own group (name, picture, count, their items, their topics). */
export async function teamProject(catalog: Catalog, id: string, boardId = defaultId()) {
  const p = teamProjects(catalog, boardId).find((x) => x.id === id); if (!p) return null;
  const { byProject } = await collect(catalog, boardId);
  const posts = byProject.get(id) ?? [];
  const items = posts.map((x) => x.item).sort((a, b) => b.saved.localeCompare(a.saved));
  const dir = boardDir(boardId); mkdirSync(dir, { recursive: true });
  let groups: TopicView[] = [{ id: "all", name: "Everything", by: "librarian", items: items.map((i) => i.id) }];
  try { groups = await reconcile(dir, p, items); } catch (e) { console.error(`[team topics] ${id}: ${(e as Error).message}`); }
  const people = contributors(posts, getBoard(boardId), id).map(({ since: _, ...who }) => {
    const theirs = items.filter((it) => (it as any).person === who.id);
    return { ...who, items: theirs, groups: only(groups, new Set(theirs.map((it) => it.id))) };
  });
  return { board: boardId, project: p, items, counts: countKinds(items), groups, people, team: true };
}

/** One project's board: posts from the same shortcut run (same person, same sentence) are one card. */
export async function board(catalog: Catalog, projectId: string, boardId = defaultId()) {
  const projects = teamProjects(catalog, boardId);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  if (!project) return { projects: [], project: null, cards: [], people: [] };
  const { byProject } = await collect(catalog, boardId);
  const cards = new Map<string, { key: string; person: string; who: string; notes: string; title: string; files: string[]; saved: string; pending: boolean }>();
  for (const p of byProject.get(project.id) ?? []) {
    const key = `${p.person}|${p.batch}`;
    const c = cards.get(key) ?? { key, person: p.person, who: p.who, notes: p.notes, title: p.title, files: [], saved: p.saved, pending: false };
    for (const f of p.files) if (!c.files.includes(f)) c.files.push(f);
    c.pending ||= p.pending; if (p.saved > c.saved) c.saved = p.saved;
    cards.set(key, c);
  }
  const list = [...cards.values()].sort((a, b) => b.saved.localeCompare(a.saved) || a.who.localeCompare(b.who));
  const counts = new Map<string, { id: string; name: string; n: number; avatar: string | null }>();
  for (const c of list) { const r = counts.get(c.person) ?? { id: c.person, name: c.who, n: 0, avatar: avatarUrl(c.person) }; r.n += c.files.length || 1; counts.set(c.person, r); }
  return {
    board: boardId,
    projects: projects.map((p) => ({ id: p.id, name: p.name, n: (byProject.get(p.id) ?? []).reduce((s, x) => s + (x.files.length || 1), 0) })),
    project: { id: project.id, name: project.name },
    cards: list.map((c) => ({ ...c, files: c.files.map((f) => ({ path: f, visual: VISUAL.test(f) || /\.(mp4|mov|m4v|webm)$/i.test(f), video: /\.(mp4|mov|m4v|webm)$/i.test(f), name: f.split("/").pop() })) })),
    people: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Whether a save ("<personId>:<slug>") is on a board right now. */
export async function onBoard(catalog: Catalog, boardId: string, item: string): Promise<boolean> {
  for (const posts of (await collect(catalog, boardId)).byProject.values()) if (posts.some((x) => x.id === item)) return true;
  return false;
}

/** Whether a file is on any board this person can see (the board picture handler asks before serving). */
export async function canFetch(catalog: Catalog, personId: string, rel: string): Promise<boolean> {
  if (rel.includes("..")) return false;
  for (const b of boardsFor(personId)) if ((await collect(catalog, b.id)).allowed.has(rel)) return true;
  return false;
}

const CACHE = join(ROOT, ".board-cache");
const cached = (rel: string, size: string) => join(CACHE, `${size}-${rel.replace(/[\/]/g, "_").replace(/\.[^.]+$/, "")}.jpg`);

export type Size = "small" | "thumb" | "full";
const PX: Record<Size, [string, string]> = { small: ["360", "70"], thumb: ["720", "75"], full: ["2400", "88"] };
/** Make a photo's board sizes ahead of time, so the board opens fast tomorrow. */
export async function warm(rel: string) {
  const abs = join(ROOT, rel); if (!VISUAL.test(abs) || !existsSync(abs)) return;
  mkdirSync(CACHE, { recursive: true });
  for (const [size, px, q] of [["small", "360", "70"], ["thumb", "720", "75"], ["full", "2400", "88"]]) {
    const out = cached(rel, size); if (existsSync(out)) continue;
    await Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", q, "-Z", px, abs, "--out", out], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}
/** The small size only (what the folders and grids show), made ahead of time when the app starts. */
export async function warmSmall(rel: string) {
  const abs = join(ROOT, rel); if (!VISUAL.test(abs) || !existsSync(abs)) return;
  const out = cached(rel, "small"); if (existsSync(out)) return;
  mkdirSync(CACHE, { recursive: true });
  await Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", PX.small[1], "-Z", PX.small[0], abs, "--out", out], { stdout: "ignore", stderr: "ignore" }).exited;
}
/** A file on a board this person can see, as a JPEG any browser (and Figma) can show: "small" (360px, for the
 *  grids and folders), "thumb" (720px) or "full" (2400px). A saved file never changes, so each is cached a year. */
export async function boardImage(catalog: Catalog, personId: string, rel: string, size: Size): Promise<Response> {
  if (!(await canFetch(catalog, personId, rel))) return new Response("not found", { status: 404 });
  return imageOf(rel, size);
}
async function imageOf(rel: string, size: Size): Promise<Response> {
  const abs = join(ROOT, rel); if (!existsSync(abs)) return new Response("not found", { status: 404 });
  mkdirSync(CACHE, { recursive: true });
  const out = cached(rel, size);
  if (!existsSync(out)) {
    if (/\.(mp4|mov|m4v|webm)$/i.test(abs)) {
      if (size === "full") return new Response(Bun.file(abs));
      for (const at of ["1", "0"]) { if (existsSync(out)) break; await Bun.spawn(["ffmpeg", "-v", "error", "-y", "-ss", at, "-i", abs, "-frames:v", "1", "-vf", `scale=${PX[size][0]}:-2`, "-q:v", "4", out]).exited; }
    } else if (VISUAL.test(abs)) {
      await Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", PX[size][1], "-Z", PX[size][0], abs, "--out", out], { stdout: "ignore", stderr: "ignore" }).exited;
    } else return new Response(Bun.file(abs), { headers: { "content-disposition": `inline; filename="${abs.split("/").pop()}"` } });
    if (!existsSync(out)) return new Response(Bun.file(abs));
  }
  return new Response(Bun.file(out), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
}

/** Everything in one board project as a zip, named by person, photos as JPEG (Figma and Miro don't take HEIC).
 *  The caller checks membership first. */
export async function boardZip(catalog: Catalog, projectId: string, boardId = defaultId()): Promise<Response> {
  const b = await board(catalog, projectId, boardId); if (!b.project) return new Response("not found", { status: 404 });
  const work = join(CACHE, `zip-${Date.now()}`); const folder = join(work, b.project.name); mkdirSync(folder, { recursive: true });
  const n = new Map<string, number>();
  const notes: string[] = [`${b.project.name}: everyone's inspiration`, ""];
  for (const c of b.cards) {
    if (c.notes) notes.push(`${c.who}: ${c.notes.replace(/\s+/g, " ")}`);
    for (const f of c.files) {
      const i = (n.get(c.who) ?? 0) + 1; n.set(c.who, i);
      const base = `${c.who} ${String(i).padStart(2, "0")}`;
      if (VISUAL.test(f.path) && !/\.(jpe?g|png|gif|webp)$/i.test(f.path)) {
        await imageOf(f.path, "full");
        const jpg = cached(f.path, "full");
        if (existsSync(jpg)) { await Bun.write(join(folder, `${base}.jpg`), Bun.file(jpg)); continue; }
      }
      await Bun.write(join(folder, `${base}${extname(f.path).toLowerCase()}`), Bun.file(join(ROOT, f.path)));
    }
  }
  await Bun.write(join(folder, "Who said what.txt"), notes.join("\n") + "\n");
  const zip = join(work, "board.zip");
  const code = await Bun.spawn(["zip", "-q", "-r", zip, b.project.name], { cwd: work }).exited;
  if (code !== 0) { rmSync(work, { recursive: true, force: true }); return new Response("couldn't make the zip", { status: 500 }); }
  const bytes = await Bun.file(zip).arrayBuffer();
  rmSync(work, { recursive: true, force: true });
  return new Response(bytes, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${b.project.name} board.zip"` } });
}
