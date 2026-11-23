// Remind: the moments of a person's highest inspiration come back to their phone until they are lived.
// Knowing, then understanding, thinking, doing, being. How it is built from what is known about memory:
//   Spacing      Each spark returns on a widening ladder (1, 2, 4, 7, 14, 30, 60 days). Spread-out returns
//                beat cramming (Ebbinghaus; Cepeda et al. 2006).
//   Retrieval    Every third return asks a question first and shows the words on tap. Calling a thing up
//                yourself fixes it far better than rereading it (Roediger and Karpicke 2006).
//   Own words    The person's exact words, never paraphrased: we remember what we said about ourselves best
//                (self-reference effect).
//   If-then      Each spark carries one "When ..., I ..." line. A plan tied to a moment more than doubles
//                follow-through (Gollwitzer and Sheeran 2006).
//   Timing       Ways of being in the morning (they set the day), the rest midday and early evening, nothing
//                after 8pm. At most three a day, at a different minute each day, so the phone never becomes
//                wallpaper (habituation).
//   Lived        "Yes, lived it" moves it to the evidence jar: proof of what has been embodied, kept to come
//                back to, never sent again. "Still landing" puts it away until tomorrow. (Max, 22 Nov 2026)
//   Clusters     The evidence groups itself by meaning, with the same living topics that group a project's
//                items (topics.ts): a cluster is born from three close ones, divides when large, fuses when alike.
// One ledger per person (<dir>/remind.json) and the phones that asked for it (<dir>/push.json).

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import webpush from "web-push";
import * as store from "./store.ts";
import { DATA, TWIN } from "./paths.ts";
import { reconcile, type TopicView } from "./topics.ts";

// "asset": something saved (a picture, a note, a link) put into Remind from its project, with the person's own words on how, when and what for.
export type Kind = "being" | "realization" | "principle" | "idea" | "quote" | "asset";
export type Spark = {
  id: string; words: string; title: string; question?: string; when_then?: string; kind: Kind;
  from: { slug?: string; title: string; date: string };
  step: number; next: string; sent: number; asked: number; lived: string[]; landing: number;
  state: "on" | "being" | "evidence" | "let-go"; created: string; last?: string;
  hold?: string;     // "Still landing": out of sight until this moment (tomorrow)
  evidence?: string; // when it was lived and went into the evidence jar
  thumb?: string;    // an asset's picture (a path under the person's library), shown on its tile
};
type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; added: string; ua?: string };
type Ledger = { sparks: Spark[]; sent: Record<string, string[]>; tz?: string };

const LADDER = [1, 2, 4, 7, 14, 30, 60];            // days until the next return, by step
const DAY = 864e5;
export const TZ = "America/Los_Angeles";
// Windows a spark can arrive in (local time, minutes after midnight), and the kinds each one favors.
const WINDOWS = [
  { name: "morning", from: 8 * 60, to: 9 * 60 + 30, kinds: ["being", "principle"] },
  { name: "midday", from: 12 * 60 + 30, to: 15 * 60, kinds: ["realization", "idea", "principle"] },
  { name: "evening", from: 18 * 60 + 30, to: 19 * 60 + 45, kinds: ["quote", "realization", "being"] },
] as const;

const file = (dir: string) => join(dir, "remind.json");
const subsFile = (dir: string) => join(dir, "push.json");
const empty = (): Ledger => ({ sparks: [], sent: {} });
export function ledger(dir: string): Ledger { try { return store.read<Ledger>(file(dir), empty()); } catch (e) { console.error(`[remind] ${String(e).slice(0, 200)}`); return empty(); } }
const change = (dir: string, fn: (l: Ledger) => Ledger | void) => store.update<Ledger>(file(dir), empty(), fn);
export const subs = (dir: string): Sub[] => { try { return store.read<Sub[]>(subsFile(dir), []); } catch { return []; } };
export const on = (dir: string) => subs(dir).length > 0;

// ── Keys for Web Push (VAPID), made once, kept outside every library and outside git ──
const VAPID_FILE = TWIN ? join(DATA, "push-vapid.json") : join(Bun.env.HOME ?? "", ".gbrain/serve/push-vapid.json");
function vapid(): { publicKey: string; privateKey: string } {
  if (existsSync(VAPID_FILE)) return JSON.parse(readFileSync(VAPID_FILE, "utf8"));
  const k = webpush.generateVAPIDKeys(); store.writeNow(VAPID_FILE, k); return k;
}
export const publicKey = () => vapid().publicKey;

export async function subscribe(dir: string, s: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, ua = "") {
  if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw new Error("not a push subscription");
  const row: Sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, added: new Date().toISOString(), ua: ua.slice(0, 160) };
  await store.update<Sub[]>(subsFile(dir), [], (rows) => [...rows.filter((r) => r.endpoint !== row.endpoint), row]);
}
export async function unsubscribe(dir: string, endpoint: string) {
  await store.update<Sub[]>(subsFile(dir), [], (rows) => rows.filter((r) => r.endpoint !== endpoint));
}

/** Send one notification to every phone the person turned Remind on for. Dead subscriptions are dropped. */
export async function push(dir: string, msg: { title: string; body: string; url: string; tag?: string }): Promise<number> {
  const k = vapid(); let ok = 0;
  for (const s of subs(dir)) {
    try {
      const d = webpush.generateRequestDetails(s, JSON.stringify(msg), { vapidDetails: { subject: "https://github.com/maximilian-dollaz/recall", publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600, urgency: "normal" });
      const r = await fetch(d.endpoint, { method: "POST", headers: d.headers as any, body: d.body });
      if (r.status === 404 || r.status === 410) { await unsubscribe(dir, s.endpoint); console.log(`[remind] a phone turned notifications off; dropped it`); continue; }
      if (!r.ok) { console.error(`[remind] push ${r.status}: ${(await r.text()).slice(0, 160)}`); continue; }
      ok++;
    } catch (e) { console.error(`[remind] push: ${String(e).slice(0, 200)}`); }
  }
  return ok;
}

// ── Local time ──
function parts(d: Date, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export const localDay = (d = new Date()) => parts(d).day;
/** The moment it is `minute` minutes past midnight on `day` (YYYY-MM-DD) in the person's time zone. */
export function localTime(day: string, minute: number, tz = TZ): Date {
  const [y, m, d] = day.split("-").map(Number); const want = Date.UTC(y, m - 1, d, 0, minute); let t = want;
  for (let i = 0; i < 2; i++) { const p = parts(new Date(t), tz); const [py, pm, pd] = p.day.split("-").map(Number); t -= Date.UTC(py, pm - 1, pd, 0, p.minute) - want; }
  return new Date(t);
}
/** Today's minute for each window: different every day, the same all day (so a restart doesn't reroll it). */
function slotMinute(day: string, w: typeof WINDOWS[number]) {
  const h = Number(Bun.hash(`${day}|${w.name}`) % 10_000n) / 10_000;
  return Math.round(w.from + h * (w.to - w.from));
}

// ── Adding ──
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export async function add(dir: string, s: Pick<Spark, "words" | "title" | "kind" | "from"> & Partial<Pick<Spark, "question" | "when_then" | "thumb">>, firstAt?: Date) {
  let made: Spark | undefined;
  await change(dir, (l) => {
    // Already there: the same words (or, for an asset, the same asset with the same words).
    if (l.sparks.some((x) => norm(x.words) === norm(s.words) && (s.kind !== "asset" || x.from.slug === s.from.slug))) return;
    // New sparks start tomorrow or later, spread out so the first days aren't a flood.
    const waiting = l.sparks.filter((x) => x.state === "on" && x.sent === 0).length;
    const start = firstAt ?? new Date(Date.now() + (1 + Math.floor(waiting / 3)) * DAY);
    made = { id: Math.random().toString(36).slice(2, 10), words: s.words.trim(), title: s.title.trim(), question: s.question?.trim() || undefined, when_then: s.when_then?.trim() || undefined,
      kind: s.kind, from: s.from, ...(s.thumb ? { thumb: s.thumb } : {}), step: 0, next: start.toISOString(), sent: 0, asked: 0, lived: [], landing: 0, state: "on", created: new Date().toISOString() };
    l.sparks.push(made);
  });
  return made;
}

// ── Choosing and sending ──
/** The spark for this window: one that is due, of a kind that fits the window when there is one, longest-waiting first. */
export function pick(l: Ledger, w: typeof WINDOWS[number], now = new Date()): Spark | undefined {
  const due = l.sparks.filter((s) => (s.state === "on" || s.state === "being") && new Date(s.next) <= now && !(s.hold && new Date(s.hold) > now));
  const today = localDay(now);
  const fresh = due.filter((s) => !(s.last && localDay(new Date(s.last)) === today)); // never the same one twice a day
  const fit = fresh.filter((s) => (w.kinds as readonly string[]).includes(s.kind));
  return (fit.length ? fit : fresh).sort((a, b) => a.next.localeCompare(b.next))[0];
}

/** What the lock screen shows. Every third return is a question; the words wait behind the tap. */
export function message(s: Spark, base: string) {
  const ask = s.question && s.sent % 3 === 2;
  const when = new Date(s.from.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return ask
    ? { title: s.question!, body: "Answer it in your head, then tap to see what you said.", url: `/remind/${s.id}?ask=1`, tag: s.id, ask: true }
    : { title: s.title, body: s.kind === "asset" ? s.words : `“${s.words}” (you, ${when})`, url: `/remind/${s.id}`, tag: s.id, ask: false };
}

async function sendOne(dir: string, s: Spark, base: string) {
  const m = message(s, base);
  const n = await push(dir, m);
  if (!n) return 0;
  await change(dir, (l) => {
    const x = l.sparks.find((y) => y.id === s.id); if (!x) return;
    x.sent++; if (m.ask) x.asked++; x.last = new Date().toISOString();
    const days = x.state === "being" ? 30 : LADDER[Math.min(x.step, LADDER.length - 1)];
    x.step = Math.min(x.step + 1, LADDER.length - 1);
    x.next = new Date(Date.now() + days * DAY).toISOString();
  });
  console.log(`[remind] sent "${s.title}" (${m.ask ? "question" : "words"}) to ${n} phone(s)`);
  return n;
}

/** Called every few minutes: in each window whose minute has come today and hasn't been used, send one spark. */
export async function tick(dir: string, base: string, now = new Date()) {
  if (!on(dir)) return;
  const { day, minute } = parts(now, ledger(dir).tz ?? TZ);
  for (const w of WINDOWS) {
    const l = ledger(dir);
    if ((l.sent[day] ?? []).includes(w.name)) continue;
    if (minute < slotMinute(day, w) || minute > w.to + 30) continue; // a window missed by more than half an hour waits for tomorrow
    const s = pick(l, w, now);
    await change(dir, (x) => { x.sent[day] = [...(x.sent[day] ?? []), w.name]; for (const d of Object.keys(x.sent)) if (d < localDay(new Date(Date.now() - 14 * DAY))) delete x.sent[d]; });
    if (s) await sendOne(dir, s, base);
  }
}

/** "Send one now" (testing, or wanting one): the most overdue spark, or the oldest one if none is due. */
export async function now(dir: string, base: string) {
  const l = ledger(dir);
  const s = pick(l, WINDOWS[0], new Date(Date.now() + 365 * DAY)) ?? l.sparks.find((x) => x.state === "on");
  return s ? sendOne(dir, s, base) : 0;
}

// ── What the person says back ──
export type Answer = "lived" | "landing" | "let-go" | "back";
export async function answer(dir: string, id: string, a: Answer) {
  let out: Spark | undefined;
  await change(dir, (l) => {
    const s = l.sparks.find((x) => x.id === id); if (!s) return;
    const today = localDay();
    if (a === "lived") {
      if (!s.lived.includes(today)) s.lived.push(today);
      s.state = "evidence"; s.evidence = new Date().toISOString(); delete s.hold;
    } else if (a === "landing") {
      // Out of sight until tomorrow morning (local), and back on the phone from then.
      const start = localTime(localDay(new Date(Date.now() + DAY)), 7 * 60); // 7am tomorrow, local
      s.landing++; s.step = Math.max(0, s.step - 2); s.hold = start.toISOString();
      if (new Date(s.next) < start) s.next = start.toISOString();
    }
    else if (a === "let-go") s.state = "let-go";
    else if (a === "back") { s.state = "on"; delete s.hold; s.next = new Date(Date.now() + DAY).toISOString(); }
    out = s;
  });
  return out;
}

/** Where a spark stands on the way from knowing to being. */
export function stage(s: Spark): "knowing" | "understanding" | "thinking" | "doing" | "being" {
  if (s.state === "being" || s.state === "evidence") return "being";
  if (s.lived.length) return "doing";
  if (s.asked) return "thinking";
  if (s.sent) return "understanding";
  return "knowing";
}
export const view = (s: Spark) => ({ ...s, stage: stage(s) });

/** The evidence jar in clusters, grouped the way a project's items are (topics.ts). Spark ids come back as they are. */
const EVIDENCE = { id: "remind-evidence", name: "Evidence" };
export async function clusters(dir: string): Promise<TopicView[]> {
  const ev = ledger(dir).sparks.filter((s) => s.state === "evidence");
  const items = ev.map((s) => ({ id: `rm-${s.id}`, title: s.title, kind: "remind", summary: s.words, notes: s.when_then ?? "", saved: (s.evidence ?? s.created ?? "").slice(0, 10), files: [], tags: [] }));
  const strip = (t: TopicView): TopicView => ({ ...t, items: t.items.map((i) => i.replace(/^rm-/, "")), ...(t.children ? { children: t.children.map(strip) } : {}) });
  return (await reconcile(dir, EVIDENCE, items)).map(strip);
}

// ── New saves: sparks found in the person's own words ──
/** The passages in a new meeting or voice note worth coming back. `chat` is the librarian's model; `locate`
 *  checks the words are really in the text (a made-up quote is dropped). At most two, often none. */
export async function find(text: string, title: string, chat: (m: any[], o?: any) => Promise<string>, locate: (t: string, q: string) => number) {
  const said = /\bremind\b/i.test(text);
  const raw = await chat([{ role: "user", content: `Below is something the owner of this library recorded or wrote ("${title}"). Find at most 2 passages in the owner's OWN words (not other speakers) that are worth bringing back to them again and again until they live it: a realization about themselves, a principle for how to live or work, a way of being they want to step into, or a line that moved them. Skip logistics, plans, tasks, small talk and anything ordinary. Most recordings have none: an empty list is the right answer then.${said ? ' The owner said "remind" in this text: the passage they asked to be reminded of must be one of the two.' : ""}

For each passage return:
- words: copied exactly from the text, one to three sentences, under 240 characters. You may cut stumbles and repeated words with "..." but never change or add a word.
- title: 2 to 5 plain words naming it, in their voice (example: "Speak, it lifts everyone").
- kind: one of being, realization, principle, idea, quote.
- question: one short question that makes them recall it without seeing it (example: "What happens when you hold back in a group?").
- when_then: one line "When <a real moment in their day>, I <a small act>." that turns it into action.

Answer JSON only: {"sparks":[...]}.

TEXT:
${text.slice(0, 24_000)}` }], { json: true });
  let parsed: any; try { parsed = JSON.parse(raw.replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch { return []; }
  const kinds = new Set(["being", "realization", "principle", "idea", "quote"]);
  return (Array.isArray(parsed?.sparks) ? parsed.sparks : []).slice(0, 2).filter((s: any) =>
    typeof s?.words === "string" && typeof s?.title === "string" && kinds.has(s.kind) &&
    s.words.split(/\.{3}|…/).map((p: string) => p.trim()).filter((p: string) => p.length >= 12).every((p: string) => locate(text, p) >= 0));
}

// ── From a project: put an asset into Remind with a note on how, when and what for ──
/** One reminder per chosen item, carrying the person's note as its words. A date said in the note ("next Friday",
 *  "in two weeks") is when it first comes back; otherwise tomorrow. `when` parses the date (reminders.parseWhen). */
export async function addAssets(dir: string, items: { id: string; title: string; saved: string; thumb?: string }[], note: string, when: (said: string) => string | undefined) {
  const words = note.replace(/\s+/g, " ").trim().slice(0, 400); if (words.length < 3) return [];
  const day = when(words); const first = day ? localTime(day, 8 * 60 + 30, ledger(dir).tz ?? TZ) : undefined;
  // One reminder for what was picked together (its first picture on the tile), not one per asset.
  const it = items[0]; if (!it) return [];
  const pic = items.find((x) => x.thumb)?.thumb;
  const title = items.length > 1 ? `${it.title.slice(0, 60)} and ${items.length - 1} more` : it.title.slice(0, 80);
  const s = await add(dir, { words, title, kind: "asset", from: { slug: it.id, title: it.title, date: (it.saved || localDay()).slice(0, 10) }, thumb: pic }, first && first > new Date() ? first : undefined);
  return s ? [s] : [];
}
