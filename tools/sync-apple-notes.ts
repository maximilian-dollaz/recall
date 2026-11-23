// Apple Notes into Recall. Apple Notes has no web API, so this runs ON THE MAC: it asks the Notes app (through
// osascript) for notes written or changed since the last run and saves each one to Recall like any other save.
//
//   bun tools/sync-apple-notes.ts            save new notes (at most 25 per run, oldest first)
//   bun tools/sync-apple-notes.ts --dry      print what it would send; nothing is sent, nothing is recorded
//   --since 2026-01-01   where the very first run starts (default: 30 days back)    --edited   send a note again when it changes
//
// The first run makes macOS ask "allow Terminal to control Notes": the owner must say yes, once.
// Where it saves: RECALL_URL (default http://localhost:3344). On the Mac that runs Recall, that is enough.
// Against a Recall on a server, give it a personal save key (the same kind the Save to Recall shortcut carries;
// it can only save): RECALL_KEY, or the file ~/.gbrain/serve/apple-notes.key. The key is never printed.
// What it remembers: ~/.gbrain/serve/apple-notes-sync.json (last sync time, and the notes already sent).
// Locked notes are skipped: their words can't be read, and they are locked for a reason.

import { readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import * as store from "../app/store.ts";

export const CAP = 25;
const FIRST_DAYS = 30;
export type Note = { id: string; title: string; modified: string; locked: boolean; html: string };
export type State = { last_sync?: string; sent: Record<string, string> };
export type Listed = Omit<Note, "html">;

/** A note's HTML as plain text: lines and lists kept, tags and styling dropped. */
export function htmlToText(html: string): string {
  const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(html ?? "")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    // Every block edge becomes one line break, however many tags meet there; a <br> is a break of its own.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\u0001- ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/?(div|p|h[1-6]|li|tr|ul|ol|table|blockquote)\b[^>]*>/gi, "\u0001")
    .replace(/\u0001+/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Which notes this run sends: changed since the last sync, not locked, not sent before, oldest first, at most `cap`.
 *  `more` says the cap cut the list short, so the next run carries on from the last one sent. */
export function pick(listed: Listed[], state: State, opts: { cap?: number; now?: Date; since?: string; edited?: boolean } = {}): { send: Listed[]; skippedLocked: number; more: boolean } {
  const now = opts.now ?? new Date(), cap = opts.cap ?? CAP;
  const from = Date.parse(state.last_sync ?? opts.since ?? new Date(now.getTime() - FIRST_DAYS * 864e5).toISOString());
  const due = listed.filter((n) => Date.parse(n.modified) >= from).sort((a, b) => a.modified.localeCompare(b.modified));
  const open = due.filter((n) => !n.locked);
  const fresh = open.filter((n) => !(n.id in state.sent) || (!!opts.edited && state.sent[n.id] < n.modified));
  return { send: fresh.slice(0, cap), skippedLocked: due.length - open.length, more: fresh.length > cap };
}

/** The state after a run: every sent note recorded; the clock moves to the run's start, or, when the cap cut the
 *  list short, only to the last note sent so the rest are picked up next time. */
export function advance(state: State, sent: Listed[], more: boolean, startedAt: Date): State {
  const next: State = { last_sync: state.last_sync, sent: { ...state.sent } };
  for (const n of sent) next.sent[n.id] = n.modified;
  next.last_sync = more ? (sent.at(-1)?.modified ?? state.last_sync) : startedAt.toISOString();
  return next;
}

export type Reader = { list: () => Promise<Listed[]>; body: (id: string) => Promise<string> };
export type Send = (note: { title: string; text: string }) => Promise<void>;

/** One run. The reader and the sender are passed in, so tests never touch the Notes app or the network. */
export async function run(reader: Reader, send: Send, state: State, opts: { dry?: boolean; cap?: number; now?: Date; since?: string; edited?: boolean; log?: (s: string) => void } = {}): Promise<{ state: State; sent: number; would: number; skippedLocked: number; more: boolean; error?: string }> {
  const log = opts.log ?? (() => {}), started = opts.now ?? new Date();
  const { send: todo, skippedLocked, more } = pick(await reader.list(), state, { ...opts, now: started });
  const done: Listed[] = []; let error: string | undefined;
  for (const n of todo) {
    try {
      const text = htmlToText(await reader.body(n.id));
      const title = n.title.trim() || text.split("\n")[0]?.slice(0, 80) || "Untitled note";
      if (opts.dry) { log(`would send: ${title} (${text.length} characters, changed ${n.modified.slice(0, 10)})`); continue; }
      if (text) await send({ title, text }); // an empty note has nothing to save, and is not looked at again
      done.push(n);
    } catch (e) { error = String((e as Error).message ?? e).slice(0, 240); break; } // what was sent stays recorded; the rest waits for the next run
  }
  const cut = more || !!error;
  return { state: opts.dry ? state : advance(state, done, cut, started), sent: done.length, would: opts.dry ? todo.length : 0, skippedLocked, more: cut, error };
}

// ── The real reader and sender (only when run as a script) ──
async function jxa(script: string, ...args: string[]): Promise<any> {
  const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(/not authori[sz]ed|-1743/.test(err) ? "macOS hasn't allowed this to read Notes. Open System Settings, Privacy & Security, Automation, and turn on Notes for Terminal." : `Notes didn't answer: ${err.trim().slice(0, 200)}`);
  return JSON.parse(out);
}
const notesApp: Reader = {
  // One question per column (fast even with thousands of notes); the words are fetched only for the notes sent.
  list: () => jxa(`function run() { const n = Application("Notes").notes; const id = n.id(), name = n.name(), mod = n.modificationDate(), lock = n.passwordProtected();
    return JSON.stringify(id.map((x, i) => ({ id: x, title: name[i] || "", modified: mod[i].toISOString(), locked: !!lock[i] }))); }`),
  body: (id) => jxa(`function run(argv) { return JSON.stringify(Application("Notes").notes.byId(argv[0]).body()); }`, id),
};

if (import.meta.main) {
  const args = process.argv.slice(2), dry = args.includes("--dry"), edited = args.includes("--edited");
  const since = args.includes("--since") ? new Date(args[args.indexOf("--since") + 1] ?? "").toISOString() : undefined;
  const home = join(process.env.HOME ?? "", ".gbrain/serve"), FILE = join(home, "apple-notes-sync.json");
  const base = (process.env.RECALL_URL ?? "http://localhost:3344").replace(/\/$/, "");
  const key = process.env.RECALL_KEY || (() => { try { return readFileSync(join(home, "apple-notes.key"), "utf8").trim(); } catch { return ""; } })();
  const url = key ? `${base}/k/${key}/api/save` : `${base}/api/save`;
  const who = process.env.RECALL_WHO ?? "";
  const send: Send = async ({ title, text }) => {
    const form = new FormData();
    form.set("notes", `From Apple Notes: ${title}\n\n${text}`);
    if (who) form.set("who", who);
    const r = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Recall answered ${r.status} at ${base}${key ? "" : " (no save key set)"}`); // never the key
  };
  try {
    const state = store.read<State>(FILE, { sent: {} }); state.sent ??= {};
    const r = await run(notesApp, send, state, { dry, edited, since, log: console.log });
    if (!dry) { store.writeNow(FILE, r.state); chmodSync(FILE, 0o600); }
    if (r.error) console.error(r.error);
    console.log(dry ? `Dry run: ${r.would} would be sent, nothing was. ${r.skippedLocked} locked skipped.` : `${r.sent} note${r.sent === 1 ? "" : "s"} saved to Recall. ${r.skippedLocked} locked skipped.${r.more ? " More are waiting: run it again." : ""}`);
    if (r.error) process.exit(1);
  } catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1); }
}
