// "Bring this back": a small ledger per person. One row per item that asked to
// come back, either on a date or when a named project is being worked on.
// Items in state done/parked never come back.

import { join } from "node:path";
import * as store from "./store.ts";

export type Reminder = { id: string; title: string; summary: string; local: boolean; saved: string; due?: string; when?: string; state: string; shown?: string };

function fileFor(personDir: string) { return join(personDir, "reminders.json"); }
// An unreadable ledger is left as it is and said out loud: changes to it fail, and nothing comes back from it,
// rather than an empty list being written over everyone's reminders.
const say = (personDir: string, e: any) => console.error(`[reminders] ${fileFor(personDir)} left untouched: ${e?.message ?? e}`);
function load(personDir: string): Reminder[] {
  try { return store.read<Reminder[]>(fileFor(personDir), []); } catch (e) { say(personDir, e); return []; }
}
/** The ledger for a change: an unreadable one throws here, so the change fails instead of starting from empty. */
function peek(personDir: string): Reminder[] { try { return store.read<Reminder[]>(fileFor(personDir), []); } catch (e) { say(personDir, e); throw e; } }
/** Change one person's ledger on a fresh read, one change at a time. */
async function change(personDir: string, fn: (rows: Reminder[]) => Reminder[] | void) {
  await store.update<Reminder[]>(fileFor(personDir), [], fn).catch((e) => { say(personDir, e); throw e; });
}

export function dueDate(remind: string): string | undefined {
  const d = new Date();
  if (remind === "2w") d.setDate(d.getDate() + 14);
  else if (remind === "2m") d.setMonth(d.getMonth() + 2);
  else return undefined;
  return iso(d);
}

export async function addReminder(personDir: string, r: Omit<Reminder, "state"> & { state?: string }) {
  await change(personDir, (rows) => { const kept = rows.filter((x) => x.id !== r.id); kept.push({ state: "idea", ...r }); return kept; });
}
export async function setState(personDir: string, id: string, state: string) {
  if (!peek(personDir).some((x) => x.id === id)) return; // nothing to change: don't touch the file
  await change(personDir, (rows) => { const r = rows.find((x) => x.id === id); if (r) r.state = state; });
}
export async function renameReminder(personDir: string, from: string, to: string) {
  if (!peek(personDir).some((x) => x.id === from)) return;
  await change(personDir, (rows) => { const r = rows.find((x) => x.id === from); if (r) r.id = to; });
}
export async function removeReminder(personDir: string, id: string) {
  if (!peek(personDir).some((x) => x.id === id)) return;
  await change(personDir, (rows) => rows.filter((x) => x.id !== id));
}
/** What should be shown today: dated ones that are due, plus "when" ones whose project matches recent searches. */
export async function due(personDir: string, recentQueries: string[] = []): Promise<Reminder[]> {
  const today = iso(new Date()); // local date, the same clock parseWhen uses
  const rows = load(personDir);
  const words = recentQueries.join(" ").toLowerCase();
  return rows.filter((r) => r.state === "idea" && (
    (r.due && r.due <= today) ||
    (r.when && words && r.when.toLowerCase().split(/\s+/).some((w) => w.length > 3 && words.includes(w)))
  )).slice(0, 5);
}
export function describe(r: { due?: string; when?: string }): string | undefined {
  if (r.when) return `when you work on ${r.when}`;
  if (r.due) return `on ${r.due}`;
  return undefined;
}

// ── Said in plain words ──────────────────────────────────────────────────────
// "bring this back next Friday", "in three weeks", "tomorrow", "on November 12th". Read by code,
// not the librarian: a small model guesses dates; this does not.
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

export function parseWhen(said: string, now = new Date()): string | undefined {
  const s = said.toLowerCase().replace(/[’']/g, "'");
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/\btomorrow\b/.test(s)) { d.setDate(d.getDate() + 1); return iso(d); }
  let m = s.match(/\bin (?:a |an )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?: of)?|few) (day|week|month|year)s?\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM[m[1].replace(" of", "")] ?? 1;
    if (m[2] === "day") d.setDate(d.getDate() + n); else if (m[2] === "week") d.setDate(d.getDate() + 7 * n);
    else if (m[2] === "month") d.setMonth(d.getMonth() + n); else d.setFullYear(d.getFullYear() + n);
    return iso(d);
  }
  m = s.match(/\b(next|this|on|by)? ?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m && (m[1] || /\b(bring|remind|back|come back|resurface|recall)\b/.test(s))) {
    const add = (DAYS.indexOf(m[2]) - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + add); return iso(d);
  }
  if (/\bnext week\b/.test(s)) { d.setDate(d.getDate() + 7); return iso(d); }
  if (/\bnext month\b/.test(s)) { d.setMonth(d.getMonth() + 1); return iso(d); }
  m = s.match(new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?\\b`)) ?? s.match(new RegExp(`\\b(?:the )?(\\d{1,2})(?:st|nd|rd|th)? of (${MONTHS.join("|")})\\b`));
  if (m) {
    const [mon, day] = MONTHS.includes(m[1]) ? [MONTHS.indexOf(m[1]), Number(m[2])] : [MONTHS.indexOf(m[2]), Number(m[1])];
    const t = new Date(d.getFullYear(), mon, day); if (t < d) t.setFullYear(t.getFullYear() + 1);
    return iso(t);
  }
  return undefined;
}

/** "This is for Structure", "file it under Next Mission": a project the owner named outright wins over the librarian's guess. */
export function namedProject(said: string): string | undefined {
  // "for the Ojai Retreat project", "this pertains to the Structure project"
  const p = said.match(/\b(?:for|pertains to|belongs to|goes (?:in|under|with))\s+(?:the\s+)?([A-Za-z0-9][\w' &-]{1,38}?)\s+project\b/i);
  if (p && !/^(the|a|an|my|our|this|that|new|next|whole)$/i.test(p[1].trim())) return p[1].trim();
  const m = said.match(/\b(?:this is for|this one is for|it's for|its for|this is about|file (?:this|it) (?:under|in|to)|put (?:this|it) (?:in|under)|project (?:called|named))\s+(?:the\s+)?([^.,;!?\n]{2,40}?)(?:\s+project)?(?=[.,;!?\n]|$)/i);
  if (!m) return undefined;
  const name = m[1].trim().split(/\s+/).slice(0, 4).join(" ");
  return /^(me|you|us|him|her|them|my|our|later|now|today|tomorrow|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))$/i.test(name) ? undefined : name;
}
