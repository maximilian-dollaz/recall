// Cues: the few decisions only the person can make, each answered with one click. Clarify asks only what
// sorts a save into the right place (Max, 3 Nov 2026):
//   privacy  The librarian thinks a save looks personal and the person didn't say. It waits, unsorted,
//            in held/ until they choose Private (the local vault) or Shareable (the library Claude can read).
//   project  Which project a save belongs to, when nobody named one (or named two), or a new one the librarian made.
// "when" (reminders) and "duplicate" cards are no longer asked; old ones are hidden.
//
// Saying it while saving skips the question: "keep this private", "okay to share", "this is for <project>".

import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import * as store from "./store.ts";

export type CueKind = "privacy" | "when" | "project" | "duplicate";
export type Cue = { id: string; kind: CueKind; item: string; title: string; snippet: string; thumb?: string; question: string; options: { id: string; label: string }[]; created: string };

const file = (dir: string) => join(dir, "cues.json");
// An unreadable cues.json is left as it is and said out loud: no questions show and answering one fails,
// rather than an empty list being written over the questions still waiting.
const say = (dir: string, e: any) => console.error(`[cues] ${file(dir)} left untouched: ${e?.message ?? e}`);
function load(dir: string): Cue[] { try { return store.read<Cue[]>(file(dir), []); } catch (e) { say(dir, e); return []; } }
/** The cues for a change: an unreadable file throws here, so the change fails instead of starting from empty. */
function peek(dir: string): Cue[] { try { return store.read<Cue[]>(file(dir), []); } catch (e) { say(dir, e); throw e; } }
/** Change one person's cues on a fresh read, one change at a time. */
async function change(dir: string, fn: (cues: Cue[]) => Cue[] | void) {
  await store.update<Cue[]>(file(dir), [], fn).catch((e) => { say(dir, e); throw e; });
}

const ORDER: Record<string, number> = { privacy: 0, project: 1, duplicate: 2, when: 3 };
const ASKED = new Set<string>(["privacy", "project"]);
export async function list(dir: string): Promise<Cue[]> { return [...load(dir)].filter((c) => ASKED.has(c.kind)).sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9)); }

export async function add(dir: string, cue: Omit<Cue, "id" | "created">) {
  if (!ASKED.has(cue.kind)) return;
  await change(dir, (cues) => {
    const kept = cues.filter((c) => !(c.kind === cue.kind && c.item === cue.item));
    kept.push({ ...cue, id: Math.random().toString(36).slice(2, 10), created: new Date().toISOString() });
    return kept;
  });
}

/** Take a cue off the list. Inside the lock, so two taps on the same card answer it once. */
export async function take(dir: string, id: string): Promise<Cue | undefined> {
  if (!peek(dir).some((x) => x.id === id)) return undefined;
  let c: Cue | undefined;
  await change(dir, (cues) => { c = cues.find((x) => x.id === id); return cues.filter((x) => x.id !== id); });
  return c;
}

/** Drop one kind of cue about an item (a hand placement answers "which project?" but not "when"). */
export async function forgetKind(dir: string, item: string, kind: CueKind) {
  if (!peek(dir).some((c) => c.item === item && c.kind === kind)) return;
  await change(dir, (cues) => cues.filter((c) => !(c.item === item && c.kind === kind)));
}
/** Drop any cue about an item (it was deleted, moved or answered elsewhere). */
export async function forget(dir: string, item: string) {
  if (!peek(dir).some((c) => c.item === item)) return;
  await change(dir, (cues) => cues.filter((c) => c.item !== item));
}

// Spoken cues that answer the question up front.
export const saidPrivate = (s: string) => /\b(keep (this|it) private|this is private|private note|just for me)\b/i.test(s);
export const saidShareable = (s: string) => /\b(okay to share|ok to share|shareable|share this|fine to share)\b/i.test(s);

// Care rule: real distress stays private, gets no reminder and is never resurfaced, shared or turned into a card.
export const showsDistress = (s: string) => /\b(kill myself|killing myself|suicid\w*|want to die|wanna die|end my life|end it all|hurt myself|self[- ]harm|jump off|no reason to live)\b/i.test(s);

// Held saves (waiting on Private or Shareable).
export const heldDir = (dir: string) => { const d = join(dir, "held"); mkdirSync(d, { recursive: true }); return d; };
export function release(dir: string, jobId: string, inbox: string) {
  const from = join(heldDir(dir), `${jobId}.json`);
  if (existsSync(from)) renameSync(from, join(inbox, `${jobId}.json`));
}
