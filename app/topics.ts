// Topics inside a project: groups that form, divide and fuse on their own, like cells.
//
// Each item has exactly one home: a topic, a sub-topic, or "Loose ends" (stem cells waiting for a match).
// Two levels at most: Project → Topic → Sub-topic. Changes happen as items are saved (and whenever a
// project is opened), never by reshuffling: new groups appear, nothing moves without a reason.
//
// Closeness = meaning (local embeddings of title, summary, the person's own sentence and tags)
//           + small nudges for the same day and shared names (people, places).
// The person always wins: a topic they renamed keeps its name and never fuses; an item they moved stays.
// Thresholds were calibrated on nomic-embed-text: related items score about 0.79 to 0.87, unrelated 0.56 to 0.76.

import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Project, ProjectItem } from "./projects.ts";
import { chat } from "./librarian.ts";
import * as store from "./store.ts";

const OLLAMA = (Bun.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
const JOIN = 0.8;      // an item joins a topic when this close to the topic's centre
const BIRTH = 0.78;    // three loose items this close to each other become a new topic
const BIRTH_SIZE = 3;  // Fibonacci: a topic is born from 3
const DIVIDE_AT = 13;  // Fibonacci: a topic with more than 13 items may divide
const DIVIDE_MIN = 5;  // ...into two sub-topics of at least 5 each
const APART = 0.88;    // ...whose centres are no closer than this
const FUSE = 0.92;     // two topics this close fuse into one
const SHRINK = 3;      // a topic below 3 items joins its nearest neighbour

export type Topic = { id: string; name: string; by: "librarian" | "person"; created: string; parent?: string; members: string[] };
type ProjState = { topics: Topic[]; loose: string[]; pinned: Record<string, string> };
type State = { v: 1; projects: Record<string, ProjState> };
type Vec = number[];

const stateFile = (dir: string) => join(dir, "topics.json");
const embFile = (dir: string) => join(dir, ".embeddings.json");
const id6 = () => Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);

// One change at a time per library, on a fresh read of topics.json, written whole. An unreadable topics.json
// is left as it is (the person's renamed topics and moved items live there) and the change fails out loud.
const EMPTY: State = { v: 1, projects: {} };
async function change<T>(dir: string, fn: (state: State) => Promise<T> | T): Promise<T> {
  let out!: T;
  await store.update<State>(stateFile(dir), EMPTY, async (state) => { out = await fn(state); })
    .catch((e) => { console.error(`[topics] ${stateFile(dir)} left untouched: ${e?.message ?? e}`); throw e; });
  return out;
}

// ── Meaning ──────────────────────────────────────────────────────────────────
let projectWords: RegExp | null = null;
const textOf = (it: ProjectItem) => {
  const t = [it.title, it.summary, it.notes, it.tags.join(", ")].filter(Boolean).join(". ");
  return (projectWords ? t.replace(projectWords, " ") : t).replace(/\s+/g, " ").slice(0, 2000);
};
function setProject(p: Project) {
  const names = [p.name, ...(p.aliases ?? []), p.id.replace(/-/g, " ")].filter((n) => n.length >= 3).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+"));
  projectWords = new RegExp(`\\b(${names.join("|")})\\b|\\btnm\\b`, "gi");
}
async function embeddings(dir: string, items: ProjectItem[]): Promise<Map<string, Vec>> {
  // Only a cache: an unreadable one is rebuilt from the model rather than stopping the project view.
  let cache: Record<string, { h: string; v: Vec }> = {};
  try { cache = store.read<typeof cache>(embFile(dir), {}); } catch (e: any) { console.warn(`[topics] rebuilding unreadable ${embFile(dir)}: ${e?.message ?? e}`); }
  const need = items.filter((it) => cache[it.id]?.h !== hash(textOf(it)));
  for (let i = 0; i < need.length; i += 32) {
    const batch = need.slice(i, i + 32);
    const r = await fetch(`${OLLAMA}/api/embed`, { method: "POST", signal: AbortSignal.timeout(60_000), body: JSON.stringify({ model: "nomic-embed-text", input: batch.map((it) => `clustering: ${textOf(it)}`) }) });
    if (!r.ok) throw new Error(`embeddings failed: ${r.status}`);
    const { embeddings: vs } = await r.json() as { embeddings: Vec[] };
    batch.forEach((it, j) => (cache[it.id] = { h: hash(textOf(it)), v: unit(vs[j]) }));
  }
  if (need.length) store.writeNow(embFile(dir), cache); // inside the topics lock, so one writer per library
  return new Map(items.filter((it) => cache[it.id]).map((it) => [it.id, cache[it.id].v]));
}
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
function unit(v: Vec): Vec { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }
const dot = (a: Vec, b: Vec) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
function centre(vs: Vec[]): Vec { const c = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < v.length; i++) c[i] += v[i]; return unit(c); }

// ── Placement ────────────────────────────────────────────────────────────────
type Ctx = { st: ProjState; vec: Map<string, Vec>; byId: Map<string, ProjectItem>; project: Project };
const leaves = (st: ProjState) => st.topics.filter((t) => !st.topics.some((c) => c.parent === t.id));
const tops = (st: ProjState) => st.topics.filter((t) => !t.parent);
const membersOf = (st: ProjState, t: Topic): string[] => { const kids = st.topics.filter((c) => c.parent === t.id); return kids.length ? kids.flatMap((k) => k.members) : t.members; };
function centreOf(ctx: Ctx, ids: string[]): Vec | null { const vs = ids.map((i) => ctx.vec.get(i)).filter(Boolean) as Vec[]; return vs.length ? centre(vs) : null; }
function nudge(ctx: Ctx, it: ProjectItem, ids: string[]): number {
  let n = 0;
  if (ids.some((i) => ctx.byId.get(i)?.saved === it.saved)) n += 0.01; // saved the same day
  const names = new Set(ids.flatMap((i) => ctx.byId.get(i)?.tags ?? []));
  n += Math.min(0.02, it.tags.filter((t) => names.has(t)).length * 0.01); // shared people, places, things
  return n;
}
function bestLeaf(ctx: Ctx, it: ProjectItem): { t: Topic; score: number } | null {
  const v = ctx.vec.get(it.id); if (!v) return null;
  let best: { t: Topic; score: number } | null = null;
  for (const t of leaves(ctx.st)) {
    const c = centreOf(ctx, t.members.filter((m) => m !== it.id)); if (!c) continue;
    const score = dot(v, c) + nudge(ctx, it, t.members);
    if (!best || score > best.score) best = { t, score };
  }
  return best;
}
function place(ctx: Ctx, it: ProjectItem) {
  const st = ctx.st;
  const pin = st.pinned[it.id] && st.topics.find((t) => t.id === st.pinned[it.id]);
  if (pin) { pin.members.push(it.id); return; }
  // The person's own words: "for the signage" puts it straight into Signage.
  const said = `${it.notes ?? ""}`.toLowerCase();
  const named = leaves(st).find((t) => t.name.length >= 4 && said.includes(t.name.toLowerCase()));
  if (named) { named.members.push(it.id); return; }
  const b = bestLeaf(ctx, it);
  // A topic forming among the loose items may fit better than any existing topic: then wait with them.
  const v = ctx.vec.get(it.id);
  const looseSims = v ? st.loose.map((l) => ctx.vec.get(l)).filter(Boolean).map((l) => dot(v, l!)).sort((x, y) => y - x) : [];
  const forming = looseSims.length >= BIRTH_SIZE - 1 ? (looseSims[0] + looseSims[1]) / 2 : 0;
  if (b && b.score >= JOIN && !(forming >= BIRTH && forming > b.score)) b.t.members.push(it.id); else st.loose.push(it.id);
}

// ── Life of a topic ──────────────────────────────────────────────────────────
async function nameFor(ctx: Ctx, ids: string[], parent?: Topic): Promise<string> {
  const lines = ids.slice(0, 12).map((i) => ctx.byId.get(i)).filter(Boolean).map((it) => `- ${it!.title}${it!.summary ? `: ${it!.summary.slice(0, 120)}` : ""}`).join("\n");
  const taken = ctx.st.topics.map((t) => t.name).join(", ");
  for (let attempt = 0; attempt < 2; attempt++) try {
    const firm = attempt ? ` The name must not use the word${parent ? ` "${parent.name}"` : "s"} or any of: ${taken}.` : "";
    const out = await chat([{ role: "user", content: `These saved items belong together inside the project "${ctx.project.name}"${parent ? `, under the topic "${parent.name}"` : ""}.\n${lines}\n\nName what they share in 1 to 3 plain words, Title Case. Not the project name${parent ? " or the parent topic" : ""}. Not one of: ${taken || "none"}.${firm} Reply with the name only.` }]);
    const name = out.replace(/["*#.]/g, "").split("\n")[0].replace(projectWords ?? /$^/, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    const clash = ctx.st.topics.some((t) => t.name.toLowerCase() === name.toLowerCase()) || (parent && name.toLowerCase().includes(parent.name.toLowerCase()));
    if (name && name.split(/\s+/).length <= 4 && !clash) return name;
  } catch {}
  const avoid = new Set([...(parent?.name ?? "").toLowerCase().split(/\s+/), ...ctx.project.name.toLowerCase().split(/\s+/), "nature", "media"]);
  const words = ids.flatMap((i) => (ctx.byId.get(i)?.title ?? "").toLowerCase().split(/[^a-z]+/)).filter((w) => w.length > 4 && !avoid.has(w) && !avoid.has(w.replace(/s$/, "")));
  const top = Object.entries(words.reduce<Record<string, number>>((m, w) => ((m[w] = (m[w] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? top[0].toUpperCase() + top.slice(1) : "New topic";
}

async function births(ctx: Ctx, log: string[]) {
  const st = ctx.st;
  for (let guard = 0; guard < 8; guard++) {
    const loose = st.loose.filter((i) => ctx.vec.has(i));
    let seed: string[] | null = null;
    for (const a of loose) {
      const near = loose.filter((b) => b !== a && dot(ctx.vec.get(a)!, ctx.vec.get(b)!) + nudge(ctx, ctx.byId.get(a)!, [b]) >= BIRTH);
      if (near.length + 1 >= BIRTH_SIZE && (!seed || near.length + 1 > seed.length)) seed = [a, ...near];
    }
    if (!seed) return;
    // Keep only members close to the group's centre, so a chain of loosely linked items doesn't become a topic.
    const c = centreOf(ctx, seed)!;
    const members = seed.filter((i) => dot(ctx.vec.get(i)!, c) >= BIRTH);
    if (members.length < BIRTH_SIZE) return;
    const t: Topic = { id: id6(), name: await nameFor(ctx, members), by: "librarian", created: today(), members };
    st.topics.push(t); st.loose = st.loose.filter((i) => !members.includes(i));
    log.push(`born: ${t.name} (${members.length})`);
  }
}

function twoMeans(ctx: Ctx, ids: string[]): [string[], string[]] | null {
  const vs = ids.map((i) => ctx.vec.get(i)!);
  // Several starting pairs (the most distant ones), keep the cleanest split: where it starts shouldn't decide the outcome.
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) pairs.push([dot(vs[i], vs[j]), i, j]);
  pairs.sort((x, y) => x[0] - y[0]);
  let best: { A: string[]; B: string[]; sim: number } | null = null;
  for (const [, a, b] of pairs.slice(0, 13)) {
    let ca = vs[a], cb = vs[b], A: string[] = [], B: string[] = [];
    for (let round = 0; round < 12; round++) {
      A = []; B = []; ids.forEach((id, i) => (dot(vs[i], ca) >= dot(vs[i], cb) ? A : B).push(id));
      if (!A.length || !B.length) break;
      ca = centreOf(ctx, A)!; cb = centreOf(ctx, B)!;
    }
    if (A.length < DIVIDE_MIN || B.length < DIVIDE_MIN) continue;
    const sim = dot(ca, cb);
    if (!best || sim < best.sim) best = { A, B, sim };
  }
  return best && best.sim <= APART ? [best.A, best.B] : null;
}
async function divisions(ctx: Ctx, log: string[]) {
  const st = ctx.st;
  for (const t of tops(st)) {
    if (st.topics.some((c) => c.parent === t.id) || t.members.length <= DIVIDE_AT) continue;
    const split = twoMeans(ctx, t.members.filter((i) => ctx.vec.has(i)));
    if (!split || split[0].length < DIVIDE_MIN || split[1].length < DIVIDE_MIN) continue;
    for (const part of split) st.topics.push({ id: id6(), name: await nameFor(ctx, part, t), by: "librarian", created: today(), parent: t.id, members: part });
    const rest = t.members.filter((i) => !split[0].includes(i) && !split[1].includes(i));
    t.members = []; st.loose.push(...rest);
    log.push(`divided: ${t.name} → ${st.topics.filter((c) => c.parent === t.id).map((c) => c.name).join(" + ")}`);
  }
}

function fusions(ctx: Ctx, log: string[]) {
  const st = ctx.st;
  // Siblings (top level, or under the same parent) whose centres are nearly the same fuse into the larger one.
  for (let changed = true; changed;) {
    changed = false;
    const groups = new Map<string, Topic[]>();
    for (const t of st.topics) { const k = t.parent ?? ""; groups.set(k, [...(groups.get(k) ?? []), t]); }
    outer: for (const sibs of groups.values()) for (let i = 0; i < sibs.length; i++) for (let j = i + 1; j < sibs.length; j++) {
      const [x, y] = [sibs[i], sibs[j]];
      if (x.by === "person" && y.by === "person") continue;
      const cx = centreOf(ctx, membersOf(st, x)), cy = centreOf(ctx, membersOf(st, y));
      if (!cx || !cy || dot(cx, cy) < FUSE) continue;
      const [keep, drop] = membersOf(st, x).length >= membersOf(st, y).length || x.by === "person" ? [x, y] : [y, x];
      if (drop.by === "person") continue;
      keep.members.push(...drop.members);
      for (const c of st.topics) if (c.parent === drop.id) c.parent = keep.id;
      st.topics = st.topics.filter((t) => t !== drop);
      log.push(`fused: ${drop.name} into ${keep.name}`); changed = true; break outer;
    }
  }
  // A topic that shrank below 3 joins its nearest sibling (or goes back to Loose ends).
  for (const t of [...leaves(st)]) {
    if (t.by === "person" || t.members.length >= SHRINK || t.members.length === 0 && st.topics.some((c) => c.parent === t.id)) continue;
    const c = centreOf(ctx, t.members);
    const sibs = st.topics.filter((s) => s !== t && s.parent === t.parent && !st.topics.some((k) => k.parent === s.id));
    const near = c ? sibs.map((s) => ({ s, d: dot(c, centreOf(ctx, s.members) ?? c) })).sort((a, b) => b.d - a.d)[0] : undefined;
    if (near) near.s.members.push(...t.members); else st.loose.push(...t.members);
    st.topics = st.topics.filter((x) => x !== t);
    log.push(`shrank: ${t.name}${near ? ` joined ${near.s.name}` : " back to Loose ends"}`);
  }
  // A parent left with one child or none folds back into a single topic.
  for (const p of tops(st)) {
    const kids = st.topics.filter((c) => c.parent === p.id);
    if (kids.length === 1 || (kids.length === 0 && p.members.length === 0)) {
      p.members = kids.flatMap((k) => k.members); st.topics = st.topics.filter((t) => t.parent !== p.id);
      if (!p.members.length) st.topics = st.topics.filter((t) => t !== p);
    }
  }
}

// ── Public ───────────────────────────────────────────────────────────────────
export type TopicView = { id: string; name: string; by: string; items: string[]; children?: TopicView[] };

/** Bring a project's topics up to date with its items and return them. Safe to call on every save and every open. */
export function reconcile(dir: string, project: Project, items: ProjectItem[]): Promise<TopicView[]> {
  return change(dir, async (state) => {
    const st = state.projects[project.id] ??= { topics: [], loose: [], pinned: {} };
    const ids = new Set(items.map((i) => i.id));
    for (const t of st.topics) t.members = t.members.filter((m) => ids.has(m));
    st.loose = st.loose.filter((m) => ids.has(m));
    const placed = new Set([...st.topics.flatMap((t) => t.members), ...st.loose]);
    setProject(project);
    const vec = await embeddings(dir, items);
    const ctx: Ctx = { st, vec, byId: new Map(items.map((i) => [i.id, i])), project };
    const log: string[] = [];
    for (const it of [...items].filter((i) => !placed.has(i.id)).sort((a, b) => a.saved.localeCompare(b.saved))) { place(ctx, it); await births(ctx, log); }
    await births(ctx, log); await divisions(ctx, log); fusions(ctx, log);
    if (log.length) console.log(`[topics] ${project.id}: ${log.join("; ")}`);
    return view(st);
  });
}

function view(st: ProjState): TopicView[] {
  const out: TopicView[] = tops(st).map((t) => {
    const kids = st.topics.filter((c) => c.parent === t.id).map((c) => ({ id: c.id, name: c.name, by: c.by, items: c.members }));
    return { id: t.id, name: t.name, by: t.by, items: membersOf(st, t), ...(kids.length ? { children: kids } : {}) };
  }).filter((t) => t.items.length);
  if (st.loose.length) out.push({ id: "loose", name: out.length ? "Loose ends" : "Everything", by: "librarian", items: st.loose });
  return out;
}

/** The person renames a topic: it keeps that name and never fuses on its own. */
export function rename(dir: string, projectId: string, topicId: string, name: string) {
  return change(dir, (state) => {
    const t = state.projects[projectId]?.topics.find((x) => x.id === topicId); if (!t) return false;
    t.name = name.trim().slice(0, 40) || t.name; t.by = "person";
    return true;
  });
}

/** The person moves an item to a topic: it stays there. */
export function move(dir: string, projectId: string, itemId: string, topicId: string) {
  return change(dir, (state) => {
    const st = state.projects[projectId]; const t = st?.topics.find((x) => x.id === topicId); if (!st || !t) return false;
    for (const x of st.topics) x.members = x.members.filter((m) => m !== itemId);
    st.loose = st.loose.filter((m) => m !== itemId);
    t.members.push(itemId); st.pinned[itemId] = topicId;
    return true;
  });
}
