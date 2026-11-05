// Visualize: the team turns what's on a board into a picture or a video, together, in the moment.
//
// Everyone drags pictures and notes off the board into one sidebar and types or speaks into one word pad.
// Picture or Video drafts one prompt from all of it (the local model, or the pieces joined if it's down) and
// sends it to Higgsfield. Results land on everyone's screen; anyone can Keep one into their own library.
//
// One canvas per board (library/boards/<id>/canvas.json). Every change is an operation applied one at a time
// through store.update and bumps `version`, so people dragging and talking at once never overwrite each other;
// clients poll `state?since=` and get 204 when nothing changed.
//
// Money and privacy: nothing leaves this Mac unless the key exists AND library/visualize-budget.json has
// capUsd > 0 AND privacyOk: true (Max approves the privacy wording first). Otherwise it runs in dry mode: the
// same flow, ending in a local contact sheet of the references with the prompt, clearly labelled as a preview.
// The key is read on each call and never logged, returned or put in an error.

import { join, extname } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import * as store from "./store.ts";
import { DATA as ROOT } from "./paths.ts";
import type { Person } from "./identity.ts";
import { OWNER_NAME } from "./config.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────
export type Ref = { id: string; item: string; person: string; title: string; kind: string; summary: string; notes: string; description: string; file?: string; by: string; addedBy: string; at: string; removed?: string; removedBy?: string };
export type Words = { id: string; by: string; text: string; at: string; removed?: string; removedBy?: string };
export type Basis = { refs: string[]; words: string[] };
export type Prompt = { text: string; negative: string; by: string; version: number; at: string; drafted: boolean; basis: Basis };
export type JobStatus = "drafting" | "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled" | "preview";
export type Job = { id: string; kind: "image" | "video"; mode: "live" | "dry"; model: string; prompt: string; negative: string; drafted: boolean; refs: string[]; source?: string;
  status: JobStatus; estimateUsd: number; by: string; created: string; updated: string; files: string[]; error?: string; requestId?: string; statusUrl?: string;
  label?: string; edit?: boolean };
export type Kept = { job: string; file: string; by: string; project: string; save: string; at: string };
export type Canvas = { version: number; board: string; refs: Ref[]; words: Words[]; prompt: Prompt; jobs: Job[]; kept: Kept[]; clearedAt?: string };
export type Budget = { capUsd: number; spentUsd: number; reserved: Record<string, number>; privacyOk: boolean };
export type ModelCfg = { path: string; params?: Record<string, unknown>; label?: string; estimateUsd?: number; negativeField?: string; imageField?: string; refField?: string; refArray?: boolean; maxRefs?: number };
export type Models = { image: ModelCfg; imageRef?: ModelCfg | null; video: ModelCfg };
export type RefInfo = Omit<Ref, "id" | "addedBy" | "at" | "removed" | "removedBy">;
export type Deps = {
  /** Queue a normal save into the person's library: copies `files` (absolute paths) in and files it into `project`. */
  queueSave: (person: Person, input: { notes: string; files: string[]; project?: string }) => Promise<{ id: string }>;
  /** May this person use this board? Stub: any signed-in person, board "default", until team boards land. */
  canSee: (personId: string, boardId: string) => boolean | Promise<boolean>;
  /** Look up a dragged item (own slug, or "<personId>:<slug>" from the team board). Defaults to reading the library. */
  resolveItem?: (person: Person, itemId: string) => Promise<RefInfo | null>;
  chat?: (messages: any[], opts?: { json?: boolean }) => Promise<string>;
  fetch?: typeof fetch;
  keyFile?: string;
  now?: () => number;
};

export class VizError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ── Files ────────────────────────────────────────────────────────────────────
export const BOARD_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE_RE = /^[a-z0-9-]+\.(png|jpe?g|webp|gif|mp4|mov|webm|svg)$/;
const boardDir = (b: string) => join(ROOT, "library/boards", b);
const canvasPath = (b: string) => join(boardDir(b), "canvas.json");
const genDir = (b: string) => join(boardDir(b), "generated");
const BUDGET = () => join(ROOT, "library/visualize-budget.json");
const MODELS = () => join(ROOT, "library/visualize-models.json");
const API = "https://api.higgsfield.ai";

const OPEN: JobStatus[] = ["drafting", "queued", "in_progress"];
export const MAX_RUNNING = 2, MAX_PER_HOUR = 30;
const WORDS_MAX = 500, PROMPT_WORDS = 120;

export const freshCanvas = (board: string): Canvas => ({ version: 0, board, refs: [], words: [], prompt: { text: "", negative: "", by: "", version: 0, at: "", drafted: false, basis: { refs: [], words: [] } }, jobs: [], kept: [] });
export const freshBudget = (): Budget => ({ capUsd: 0, spentUsd: 0, reserved: {}, privacyOk: false });

// Defaults from the engineer report. Soul has no reference-image input, so dragged pictures reach image prompts
// as their saved descriptions; real pictures go to image-to-video. Add `imageRef` when Max picks a model.
// estimateUsd is only a fallback when Higgsfield's /estimate doesn't answer: set high on purpose so the cap holds.
export const DEFAULT_MODELS: Models = {
  image: { path: "higgsfield-ai/soul/standard", label: "Soul", params: { aspect_ratio: "16:9", resolution: "720p", batch_size: 1 }, estimateUsd: 0.25 },
  imageRef: null,
  video: { path: "kling-video/v2.5-turbo/standard/image-to-video", label: "Kling 2.5 Turbo", params: { duration: 5 }, negativeField: "negative_prompt", imageField: "image_url", estimateUsd: 1.5 },
};
export function loadModels(): Models {
  try { const m = store.read<Partial<Models>>(MODELS(), {}); return { ...DEFAULT_MODELS, ...m } as Models; } catch { return DEFAULT_MODELS; }
}
const goodPath = (p: string) => /^[a-z0-9][a-z0-9._\/-]*$/i.test(p) && !p.includes("..");

// ── Pure operations on a canvas (each bumps the version) ─────────────────────
const active = <T extends { removed?: string }>(xs: T[]) => xs.filter((x) => !x.removed);
const bump = (c: Canvas) => { c.version++; };
export const basisOf = (c: Canvas): Basis => ({ refs: active(c.refs).map((r) => r.id), words: active(c.words).map((w) => w.id) });
const same = (a: Basis, b: Basis) => a.refs.join() === b.refs.join() && a.words.join() === b.words.join();
const nid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function opAddRef(c: Canvas, info: RefInfo, addedBy: string, at: string): Ref {
  const had = active(c.refs).find((r) => r.item === info.item); if (had) return had; // the same picture twice is once
  const ref: Ref = { ...info, id: nid("r"), addedBy, at }; c.refs.push(ref); bump(c); return ref;
}
export function opRemoveRef(c: Canvas, refId: string, by: string, at: string) {
  const r = c.refs.find((x) => x.id === refId && !x.removed); if (!r) throw new VizError(404, "That reference is already gone.");
  r.removed = at; r.removedBy = by; bump(c);
}
/** Clear: everything leaves the panel (pictures, words, made pictures) so the next piece starts fresh. Kept pictures
 *  are already in their projects; nothing is deleted from disk. A picture still being made stays. */
export function opClear(c: Canvas, by: string, at: string) {
  for (const r of active(c.refs)) { r.removed = at; r.removedBy = by; }
  for (const w of active(c.words)) { w.removed = at; w.removedBy = by; }
  c.prompt.text = ""; c.clearedAt = at; bump(c);
}
const shown = (c: Canvas, j: Job) => !c.clearedAt || Date.parse(j.created) > Date.parse(c.clearedAt) || OPEN.includes(j.status) || j.status === "preview";
export function opAddWords(c: Canvas, text: string, by: string, at: string): Words {
  const t = text.replace(/\s+/g, " ").trim().slice(0, WORDS_MAX); if (!t) throw new VizError(400, "Say or type something first.");
  const w: Words = { id: nid("w"), by, text: t, at }; c.words.push(w); bump(c); return w;
}
export function opRemoveWords(c: Canvas, wordsId: string, by: string, at: string) {
  const w = c.words.find((x) => x.id === wordsId && !x.removed); if (!w) throw new VizError(404, "Those words are already gone.");
  w.removed = at; w.removedBy = by; bump(c);
}
/** Change the shared prompt. `baseVersion` is the prompt version the editor saw; anything else is a conflict. */
export function opSetPrompt(c: Canvas, p: { text: string; negative?: string; baseVersion: number; drafted?: boolean; basis?: Basis }, by: string, at: string): Prompt {
  if (p.baseVersion !== c.prompt.version) throw new VizError(409, "Someone else changed the prompt at the same time.");
  c.prompt = { text: p.text.trim().slice(0, 2000), negative: (p.negative ?? c.prompt.negative ?? "").trim().slice(0, 600), by, at, drafted: !!p.drafted, version: c.prompt.version + 1, basis: p.basis ?? basisOf(c) };
  bump(c); return c.prompt;
}
export function runningJobs(c: Canvas) { return c.jobs.filter((j) => OPEN.includes(j.status)).length; }
export function jobsLastHour(c: Canvas, now: number) { return c.jobs.filter((j) => now - Date.parse(j.created) < 3_600_000).length; }
export function opGenerate(c: Canvas, j: Omit<Job, "status" | "files" | "updated" | "prompt" | "negative" | "drafted" | "refs">, now: number): Job {
  if (!active(c.refs).length && !active(c.words).length && !c.prompt.text) throw new VizError(400, "Drag a picture in or add some words first.");
  if (runningJobs(c) >= MAX_RUNNING) throw new VizError(429, "Two are already being made. Wait for one to finish.");
  if (jobsLastHour(c, now) >= MAX_PER_HOUR) throw new VizError(429, `This board made ${MAX_PER_HOUR} in the last hour. Try again a bit later.`);
  const job: Job = { ...j, status: "drafting", files: [], updated: j.created, prompt: "", negative: "", drafted: false, refs: active(c.refs).map((r) => r.id) };
  c.jobs.push(job); bump(c); return job;
}
export function opJob(c: Canvas, jobId: string, patch: Partial<Job>, at: string): Job | null {
  const j = c.jobs.find((x) => x.id === jobId); if (!j) return null;
  Object.assign(j, patch, { updated: at }); bump(c); return j;
}
export function opKeep(c: Canvas, k: Kept) { c.kept.push(k); bump(c); }

// ── Budget (pure check, then the file) ───────────────────────────────────────
const cents = (n: number) => Math.round(n * 100) / 100;
export const reservedUsd = (b: Budget) => cents(Object.values(b.reserved ?? {}).reduce((s, x) => s + x, 0));
/** null when this spend fits under the cap, otherwise why not. A cap of 0 is the off switch. */
export function spendBlocked(b: Budget, usd: number): string | null {
  if (!(b.capUsd > 0)) return "Spending is switched off.";
  if (!(usd >= 0) || !isFinite(usd)) return "No price for this one, so nothing was sent.";
  if (b.spentUsd + reservedUsd(b) + usd > b.capUsd + 1e-9) return `That would go over the $${b.capUsd} limit ($${cents(b.spentUsd + reservedUsd(b))} used so far).`;
  return null;
}
export async function reserve(jobId: string, usd: number) {
  await store.update<Budget>(BUDGET(), freshBudget(), (b) => {
    b.reserved ??= {}; const why = spendBlocked(b, usd); if (why) throw new VizError(402, why);
    b.reserved[jobId] = cents(usd);
  });
}
/** A finished job's reservation becomes spent; a failed, refused or canceled one is released. */
export async function settle(jobId: string, spent: boolean, actualUsd?: number) {
  if (!existsSync(BUDGET())) return;
  await store.update<Budget>(BUDGET(), freshBudget(), (b) => {
    const r = b.reserved?.[jobId]; if (r == null) return; delete b.reserved[jobId];
    if (spent) b.spentUsd = cents((b.spentUsd ?? 0) + (actualUsd != null && isFinite(actualUsd) ? actualUsd : r));
  });
}
export function readBudget(): Budget | null { try { return { ...freshBudget(), ...store.read<Budget>(BUDGET(), freshBudget()) }; } catch { return null; } }

// ── The key: read each time, never shown ────────────────────────────────────
function readKey(file: string): string | null {
  try { const k = readFileSync(file, "utf8").trim(); return /^[^\s:]+:[^\s:]+$/.test(k) ? k : null; } catch { return null; }
}
// OpenAI makes the pictures when its key is on the Keys page (Max, 3 Nov 2026: his API credit is there).
// Videos stay with Higgsfield. gpt-image-1 prices: text in $5, image in $10, image out $40 per million tokens.
export const OPENAI_IMAGE: ModelCfg = { path: "openai/gpt-image-1", label: "GPT Image", params: { size: "1536x1024", quality: "medium" }, estimateUsd: 0.15, maxRefs: 8 };
const OPENAI_KEY = () => Bun.env.OPENAI_KEY_FILE ?? join(homedir(), ".gbrain/serve/openai.key");
function openaiKey(): string | null { try { const k = readFileSync(OPENAI_KEY(), "utf8").trim(); return /^sk-\S{16,}$/.test(k) ? k : null; } catch { return null; } }
export const usesOpenAI = (kind: string) => kind === "image" && !!openaiKey() && !usesCli(kind);

// Higgsfield's own command-line tool, signed in to Max's Higgsfield account (higgsfield auth login): pictures
// come out of his plan's credits, not an API balance (Max, 3 Nov 2026). It wins over OpenAI and the API key.
const HF_BIN = () => Bun.env.HIGGSFIELD_BIN ?? "/opt/homebrew/bin/higgsfield";
export const HF_CLI_IMAGE: ModelCfg = { path: "hfcli/gpt_image_2_5", label: "GPT Image 2.5", params: { aspect_ratio: "16:9", quality: "medium" }, estimateUsd: 0, maxRefs: 8 }; // 0.5 credits a picture
// The models Create can use (Max, 3 Nov 2026: the best one for the job, picked by itself, shown, and his to change).
export const HF_MODELS: Record<string, ModelCfg> = {
  gpt: HF_CLI_IMAGE,
  banana: { path: "hfcli/nano_banana_2", label: "Nano Banana Pro", params: { aspect_ratio: "16:9", resolution: "1k" }, estimateUsd: 0, maxRefs: 8 }, // 2 credits
  flux: { path: "hfcli/flux_3_image", label: "FLUX 3", params: { aspect_ratio: "16:9", resolution: "1k" }, estimateUsd: 0, maxRefs: 8 }, // 2 credits
};
const TEXTY = /\b(text|logo|logos|typograph\w*|letter\w*|font|sign|signage|words?|title|headline|label|menu|poster|wordmark)\b/i;
/** The picture an edit round changes: the newest finished live picture made before this job. */
export function lastPicture(c: Canvas, job: Pick<Job, "id" | "created">) {
  const last = [...c.jobs].reverse().find((j) => j.id !== job.id && shown(c, j) && j.kind === "image" && j.mode === "live" && j.status === "completed" && j.files.length && Date.parse(j.created) < Date.parse(job.created));
  // Only while it's the same round: something that went into that picture is still in the panel. After Start over
  // (or everything removed), the next picture starts fresh.
  const before = (at: string) => last && Date.parse(at) < Date.parse(last.created);
  return last && (active(c.words).some((w) => before(w.at)) || active(c.refs).some((r) => before(r.at))) ? last : undefined;
}
/** What an edit round asks for: only the words added since that picture. Null when there's nothing new to say. */
export function editPrompt(c: Canvas, last: Job | undefined): string | null {
  if (!last) return null;
  const fresh = active(c.words).filter((w) => Date.parse(w.at) > Date.parse(last.created)).map((w) => w.text.trim()).filter(Boolean);
  return fresh.length ? `Change the first picture: ${fresh.join(". ")}. Keep everything else about it the same.` : null;
}
/** Which model: Max's choice if he made one; GPT Image when words or logos matter (or by default);
 *  Nano Banana Pro when several photos are dragged in. */
export function pickModel(c: Canvas, choice?: unknown, edit = false): ModelCfg {
  if (typeof choice === "string" && HF_MODELS[choice]) return HF_MODELS[choice];
  // Changing the last picture: the same model that made it, so the look holds from round to round.
  const last = edit ? lastPicture(c, { id: "", created: new Date(8.64e15).toISOString() }) : undefined;
  const same = last && Object.values(HF_MODELS).find((m) => m.path === last.model); if (same) return same;
  const said = active(c.words).map((w) => w.text).join(" "); // people's own words, not the written prompt
  if (TEXTY.test(said)) return HF_MODELS.gpt;
  return active(c.refs).filter((r) => r.file).length >= 2 ? HF_MODELS.banana : HF_MODELS.gpt;
}
let cliSeen = { at: 0, ok: false };
/** Signed in? Asked at most once a minute (the CLI answers from its own credentials file). */
export function cliSignedIn(): boolean {
  if (Bun.env.HIGGSFIELD_BIN === "off") return false;
  if (Date.now() - cliSeen.at < 60_000) return cliSeen.ok;
  let ok = false; try { ok = existsSync(HF_BIN()) && Bun.spawnSync([HF_BIN(), "auth", "token"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch {}
  cliSeen = { at: Date.now(), ok }; return ok;
}
export const usesCli = (kind: string) => kind === "image" && cliSignedIn();
const openaiCost = (u: any) => { const d = u?.input_tokens_details ?? {}; const text = Number(d.text_tokens ?? 0), img = Number(d.image_tokens ?? 0), out = Number(u?.output_tokens ?? 0);
  return cents((text * 5 + img * 10 + out * 40) / 1e6); };

/** Live only when all three hold; otherwise dry, with the reasons (for the log and the status line). */
export function modeNow(keyFile: string, kind = "video"): { live: boolean; why: string[] } {
  const why: string[] = [];
  if (!(usesCli(kind) || usesOpenAI(kind) || readKey(keyFile))) why.push("no key");
  const b = readBudget();
  if (!b) why.push("budget file unreadable");
  else { if (!(b.capUsd > 0)) why.push("no spend cap"); if (b.privacyOk !== true) why.push("privacy wording not approved"); }
  return { live: !why.length, why };
}

// ── Prompt building ──────────────────────────────────────────────────────────
const clip = (s: string, n: number) => { const t = (s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const firstSentence = (s: string) => clip((s || "").split(/(?<=[.!?])\s/)[0], 160);
export const capWords = (s: string, n = PROMPT_WORDS) => { const w = s.trim().split(/\s+/).filter(Boolean); return w.length > n ? w.slice(0, n).join(" ") : w.join(" "); };

/** Everything the team gave, for the model: the references, what was said in order, and the last prompt. */
export function promptPieces(c: Canvas, kind: "image" | "video", sourceId?: string): string {
  const refs = active(c.refs), words = active(c.words);
  const lines: string[] = [];
  if (refs.length) {
    lines.push("Pictures and notes the team dragged in:");
    refs.forEach((r, i) => lines.push(`${i + 1}. "${r.title}" (${r.kind}${r.by ? `, saved by ${r.by}` : ""}${r.id === sourceId ? ", THE STARTING FRAME of the video" : ""})` +
      `${r.summary ? `: ${clip(r.summary, 200)}` : ""}${r.notes ? ` Their words: "${clip(r.notes, 300)}"` : ""}${r.description ? ` What the picture shows: ${clip(r.description, 500)}` : ""}`));
  }
  if (words.length) { lines.push("", "What people said, in order (later words win when they disagree):"); for (const w of words) lines.push(`- ${w.by}: ${w.text}`); }
  if (c.prompt.text) lines.push("", `The previous prompt (keep what still holds; change what the newer words change): ${c.prompt.text}`);
  lines.push("", kind === "video" ? "This is for a short video that starts from the starting frame: describe the motion, camera and mood." : "This is for one still image.");
  return lines.join("\n");
}

/** The pieces joined as they are, for when the local model is down. Later words go last, so they read as changes. */
export function fallbackPrompt(c: Canvas, kind: "image" | "video"): { prompt: string; negative: string } {
  const refs = active(c.refs), words = active(c.words);
  const seenW = new Set(c.prompt.basis?.words ?? []), seenR = new Set(c.prompt.basis?.refs ?? []);
  const prev = c.prompt.text.trim();
  const newWords = (prev ? words.filter((w) => !seenW.has(w.id)) : words).map((w) => w.text.replace(/[.\s]+$/, ""));
  const newRefs = prev ? refs.filter((r) => !seenR.has(r.id)) : refs;
  const look = newRefs.map((r) => [r.title, firstSentence(r.description || r.summary).replace(/[.…\s]+$/, "")].filter(Boolean).join(": ")).filter(Boolean);
  const parts = [
    prev ? prev.replace(/[.\s]+$/, "") + "." : "",
    newWords.length ? (prev ? "Now: " : "") + newWords.join(". ") + "." : "",
    look.length ? "Inspired by " + look.join("; ") + "." : "",
    !prev && kind === "video" ? "Slow cinematic camera movement." : "",
  ];
  return { prompt: capWords(parts.filter(Boolean).join(" ")), negative: c.prompt.negative || "" };
}

export async function draftPrompt(c: Canvas, kind: "image" | "video", chatFn: Deps["chat"], sourceId?: string): Promise<{ prompt: string; negative: string; drafted: boolean }> {
  if (chatFn) try {
    const raw = await chatFn([{ role: "user", content: `You write one prompt for an AI ${kind === "video" ? "video" : "image"} generator from a design team's live brainstorm for a brand mood board.

${promptPieces(c, kind, sourceId)}

Write a concrete visual prompt: subject, setting, materials, colours, light, mood, composition${kind === "video" ? ", motion and camera" : ""}. Use the team's own words where they are specific. When people disagree, the later words win. Never name the people. At most ${PROMPT_WORDS} words.
Also write a short negative prompt: things to keep out (only what the team ruled out, plus "text, watermark").

Reply with JSON only: {"prompt": "...", "negative": "..."}` }], { json: true });
    const p = JSON.parse(raw);
    const prompt = capWords(String(p.prompt ?? "")); if (prompt.split(/\s+/).length >= 3) return { prompt, negative: clip(String(p.negative ?? ""), 400), drafted: true };
  } catch {}
  return { ...fallbackPrompt(c, kind), drafted: false };
}

// ── The default ref lookup: a page in the person's library, or a teammate's shared one ──
const PRIVATE_PREFIX = /^(soul|gdocs|docs|notes|skills|tests)\//;
const IMG = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;
export async function resolveFromLibrary(person: Person, itemId: string): Promise<RefInfo | null> {
  if (/^(vault|pending):/.test(itemId)) return null; // private saves and unfiled ones never go into a shared canvas
  const m = itemId.match(/^([a-z0-9-]+):(.+)$/);
  const ownerId = m ? m[1] : person.id, slug = m ? m[2] : itemId;
  if (PRIVATE_PREFIX.test(slug) || slug.includes("..")) return null;
  const { listPeople, whoIs } = await import("./identity.ts");
  const { scanPages } = await import("./projects.ts");
  let owner: Person | null = ownerId === person.id ? person : null;
  if (!owner) { const ppl = (await listPeople()).people; const email = Object.keys(ppl).find((e) => ppl[e].id === ownerId); owner = email ? await whoIs("127.0.0.1", email) : null; }
  if (!owner) return null;
  const it = scanPages(owner.dir).find((x) => x.id === slug); if (!it) return null;
  if (owner.id !== person.id) {
    // Someone else's item only when it's on the team board (they share its project).
    const { isShared } = await import("./board.ts"); const { loadCatalog } = await import("./librarian.ts");
    if (!it.project || !isShared(it.project, owner.id, await loadCatalog())) return null;
  }
  let description = "";
  try {
    const md = readFileSync(join(owner.dir, `${slug}.md`), "utf8");
    description = (md.match(/## What the picture shows\n\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? "").replace(/^Saved by [^\n]*\n+/, "").replace(/^### .*$/gm, "").trim().slice(0, 900);
  } catch {}
  const file = it.files.find((f) => IMG.test(f) && join(ROOT, f).startsWith(join(owner!.dir, "files") + "/"));
  return { item: ownerId === person.id && !m ? `${person.id}:${slug}` : itemId, person: owner.id, title: it.title, kind: it.kind, summary: it.summary, notes: it.notes ?? "", description, file, by: it.by || owner.name };
}

// ── Pictures: local conversions with sips ────────────────────────────────────
async function sipsJpeg(src: string, out: string, px: number, q = 75): Promise<boolean> {
  mkdirSync(join(out, ".."), { recursive: true });
  const r = Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(q), "-Z", String(px), src, "--out", out], { stdout: "ignore", stderr: "ignore" });
  return (await r.exited) === 0 && existsSync(out);
}
const xml = (s: string) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
function wrap(text: string, width: number): string[] {
  const out: string[] = []; let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) { if ((line + " " + w).trim().length > width) { if (line) out.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) out.push(line); return out;
}

/** Dry mode's result: a contact sheet of the references with the prompt, made here, labelled as a preview. */
export async function previewSheet(board: string, job: Job, refs: Ref[], label: string): Promise<string> {
  const W = 1200, pad = 40, cols = 3, cell = Math.floor((W - pad * 2 - 16 * (cols - 1)) / cols);
  const pics = refs.filter((r) => r.file).slice(0, 6);
  const tiles: string[] = [];
  const tmp = join(boardDir(board), ".tmp", job.id);
  for (const [i, r] of pics.entries()) {
    const out = join(tmp, `${i}.jpg`);
    if (!(await sipsJpeg(join(ROOT, r.file!), out, 480, 70))) continue;
    const b64 = Buffer.from(readFileSync(out)).toString("base64");
    const x = pad + (i % cols) * (cell + 16), y = 150 + Math.floor(i / cols) * (cell + 16);
    tiles.push(`<image x="${x}" y="${y}" width="${cell}" height="${cell}" preserveAspectRatio="xMidYMid slice" href="data:image/jpeg;base64,${b64}"/>` +
      (r.id === job.source ? `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="none" stroke="#e8a95c" stroke-width="6"/>` : ""));
  }
  rmSync(tmp, { recursive: true, force: true });
  const rows = Math.ceil(tiles.length / cols);
  const textTop = 150 + (rows ? rows * (cell + 16) + 24 : 0);
  const lines = wrap(job.prompt, 88), neg = job.negative ? wrap(`Keep out: ${job.negative}`, 96) : [];
  const H = textTop + 40 + lines.length * 30 + (neg.length ? 16 + neg.length * 24 : 0) + pad;
  const names = refs.map((r) => r.title).slice(0, 8).join(" · ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#1d1a17"/>
<rect x="${pad}" y="${pad}" width="${W - pad * 2}" height="44" rx="22" fill="rgba(232,169,92,.16)" stroke="#e8a95c"/>
<text x="${W / 2}" y="${pad + 29}" text-anchor="middle" font-size="19" font-weight="600" fill="#e8a95c">${xml(label)}</text>
<text x="${pad}" y="${pad + 84}" font-size="15" fill="#c9c1b6">${xml(clip(names, 130))}</text>
${tiles.join("\n")}
<text x="${pad}" y="${textTop + 10}" font-size="13" letter-spacing="2" fill="#c9c1b6">PROMPT${job.drafted ? "" : " (JOINED, THE LOCAL MODEL WAS DOWN)"}</text>
${lines.map((l, i) => `<text x="${pad}" y="${textTop + 44 + i * 30}" font-size="22" fill="#f3eee6">${xml(l)}</text>`).join("\n")}
${neg.map((l, i) => `<text x="${pad}" y="${textTop + 44 + lines.length * 30 + 16 + i * 24}" font-size="16" fill="#a59d8f">${xml(l)}</text>`).join("\n")}
</svg>\n`;
  mkdirSync(genDir(board), { recursive: true });
  const name = `${job.id}-preview.svg`;
  await Bun.write(join(genDir(board), name), svg);
  return name;
}

// ── Everything wired together ────────────────────────────────────────────────
type WithPerson = (fn: (req: Request, p: Person) => Promise<Response>) => (req: Request) => Promise<Response>;
const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createVisualize(deps: Deps) {
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const keyFile = deps.keyFile ?? Bun.env.HIGGSFIELD_KEY_FILE ?? join(homedir(), ".gbrain/serve/higgsfield.key");
  const resolveItem = deps.resolveItem ?? resolveFromLibrary;
  const chatFn = deps.chat;
  const open = new Map<string, { board: string; job: string }>(); // live jobs waiting at Higgsfield
  const working = new Set<string>(); // jobs drafting or uploading on this Mac

  const read = (b: string) => store.read<Canvas>(canvasPath(b), freshCanvas(b));
  const change = <R>(b: string, fn: (c: Canvas) => R): Promise<R> => {
    let out!: R; return store.update<Canvas>(canvasPath(b), freshCanvas(b), (c) => { out = fn(c); }).then(() => out);
  };

  // Anything that might echo the key back (an error body, a thrown message) is scrubbed first.
  const scrub = (s: string) => { const k = readKey(keyFile); if (!k) return s; let t = s; for (const part of [k, ...k.split(":")]) if (part.length >= 4) t = t.split(part).join("[key]"); return t; };
  const say = (msg: string) => console.log(scrub(`[visualize] ${msg}`));

  async function hf(path: string, init: RequestInit & { idem?: string } = {}): Promise<any> {
    const key = readKey(keyFile); if (!key) throw new VizError(503, "Higgsfield isn't set up.");
    const url = path.startsWith(API + "/") ? path : `${API}/${path.replace(/^\//, "")}`;
    if (!url.startsWith(API + "/")) throw new VizError(500, "Refused to send the key anywhere but Higgsfield.");
    const headers: Record<string, string> = { authorization: `Key ${key}`, accept: "application/json" };
    if (init.body) headers["content-type"] = "application/json";
    if (init.idem) headers["idempotency-key"] = init.idem;
    for (let tries = 0; ; tries++) {
      const r = await http(url, { method: init.method ?? "GET", body: init.body, headers, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 && tries < 2) { const s = Math.min(30, Number(r.headers.get("retry-after")) || 5); await Bun.sleep(s * 1000); continue; }
      const text = await r.text();
      // Out of credits is Max's to fix (it's money), so say so plainly; anything else keeps Higgsfield's own words.
      if (/not_enough_credits/.test(text)) throw new VizError(402, `Higgsfield has no API credits left. ${OWNER_NAME} can add some at console.higgsfield.ai.`);
      if (!r.ok) throw new VizError(502, scrub(`Higgsfield said ${r.status}${text ? `: ${clip(text, 160)}` : ""}`));
      try { return text ? JSON.parse(text) : {}; } catch { throw new VizError(502, "Higgsfield sent something unreadable."); }
    }
  }

  async function estimate(model: ModelCfg, live: boolean): Promise<number> {
    if (live) try {
      const e = await hf(`estimate/${model.path}`, { method: "POST", body: JSON.stringify({ ...(model.params ?? {}), prompt: "estimate" }) });
      const usd = Number(e.usd); if (usd >= 0 && isFinite(usd)) return usd;
    } catch (err) { say(`estimate failed: ${String((err as Error).message).slice(0, 120)}`); }
    return model.estimateUsd ?? NaN; // NaN makes the cap refuse in live mode: no price, nothing sent
  }

  /** One picture from Higgsfield's CLI: the words, plus the dragged-in pictures as references. */
  async function cliPicture(board: string, job: Job, drafted: string, refs: Ref[]): Promise<string[]> {
    const jobId = job.id, m = Object.values(HF_MODELS).find((x) => x.path === job.model) ?? HF_CLI_IMAGE;
    // Each new round changes the last picture rather than starting over: it goes in first, with what's new.
    const c = read(board), last = job.edit !== false ? lastPicture(c, job) : undefined;
    const prompt = drafted, ids: string[] = [];
    await change(board, (cc) => opJob(cc, jobId, { status: "in_progress" }, iso())); // "Making it…"
    if (last) { const id = await cliUpload(board, join(genDir(board), last.files[0]), `${jobId}-last`); if (id) ids.push(id); }
    const args = [HF_BIN(), "generate", "create", m.path.split("/")[1], "--prompt", prompt];
    for (const [k, v] of Object.entries(m.params ?? {})) args.push(`--${k}`, String(v));
    for (const [i, ref] of refs.filter((r) => r.file).slice(0, (m.maxRefs ?? 8) - ids.length).entries()) { const id = await cliUpload(board, join(ROOT, ref.file!), `${jobId}-${i}`); if (id) ids.push(id); }
    for (const id of ids) args.push("--image-references", id);
    args.push("--wait", "--wait-timeout", "8m", "--json");
    const { code, out, said } = await cli(args);
    if (code !== 0) cliFailed(said);
    let d: any = null; try { d = JSON.parse(out); d = Array.isArray(d) ? d[0] : d; } catch {}
    const url = String(d?.result_url ?? d?.results?.[0]?.url ?? "");
    if (!/^https:\/\//.test(url)) throw new VizError(502, "Higgsfield finished but sent no picture.");
    const files = await download(board, jobId, [url]);
    if (!files.length) throw new VizError(502, "The picture couldn't be downloaded.");
    return files;
  }
  async function cli(args: string[]) {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, said: `${err}\n${out}` };
  }
  function cliFailed(said: string): never {
    if (/not authenticated|session expired|auth login/i.test(said)) { cliSeen = { at: 0, ok: false }; throw new VizError(503, `Higgsfield's sign-in on ${OWNER_NAME}'s Mac has run out. ${OWNER_NAME} signs in again: higgsfield auth login.`); }
    if (/credit|balance|insufficient/i.test(said)) throw new VizError(402, `${OWNER_NAME}'s Higgsfield plan has no credits left for this.`);
    if (/nsfw|moderat|safety/i.test(said)) throw new VizError(400, "Higgsfield's content rules stopped this one.");
    throw new VizError(502, `Higgsfield said: ${clip(scrub(said.trim().split("\n").pop() ?? ""), 160)}`);
  }
  /** A reference picture, sent once: made small first (the Mac's upload is slow), and its upload id remembered. */
  async function cliUpload(board: string, abs: string, tag: string): Promise<string | null> {
    const memo = join(boardDir(board), "hf-uploads.json"), seen = store.read<Record<string, string>>(memo, {});
    const k = `${abs}|${statSync(abs).mtimeMs}`; if (seen[k]) return seen[k];
    const small = join(boardDir(board), ".tmp", `${tag}.jpg`);
    if (!(await sipsJpeg(abs, small, 1536, 85))) return null;
    const { code, out, said } = await cli([HF_BIN(), "upload", "create", small, "--json"]);
    rmSync(small, { force: true });
    if (code !== 0) cliFailed(said);
    let id = ""; try { id = String(JSON.parse(out).id ?? ""); } catch {}
    if (!id) return null;
    await store.update<Record<string, string>>(memo, {}, (m) => { m[k] = id; });
    return id;
  }

  /** One picture from OpenAI: from the dragged-in pictures when there are any (edits), else from the words alone. */
  async function openaiPicture(board: string, jobId: string, prompt: string, refs: Ref[]): Promise<{ files: string[]; usd: number }> {
    const key = openaiKey(); if (!key) throw new VizError(503, "OpenAI isn't set up.");
    const m = OPENAI_IMAGE, params = m.params as Record<string, string>;
    const pics = refs.filter((r) => r.file).slice(0, m.maxRefs ?? 8);
    let r: Response;
    if (pics.length) {
      const form = new FormData();
      form.append("model", m.path.split("/")[1]); form.append("prompt", prompt); form.append("size", params.size); form.append("quality", params.quality); form.append("n", "1");
      for (const [i, ref] of pics.entries()) {
        let file = join(ROOT, ref.file!), ext = extname(file).slice(1).toLowerCase();
        if (!["jpg", "jpeg", "png", "webp"].includes(ext) || statSync(file).size > 20 * 1024 ** 2) {
          const out = join(boardDir(board), ".tmp", `${jobId}-${i}.jpg`); if (!(await sipsJpeg(file, out, 2048, 88))) continue; file = out; ext = "jpg";
        }
        form.append("image[]", Bun.file(file, { type: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" }), `ref-${i}.${ext}`);
      }
      r = await http("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(240_000) });
    } else {
      r = await http("https://api.openai.com/v1/images/generations", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: m.path.split("/")[1], prompt, size: params.size, quality: params.quality, n: 1 }), signal: AbortSignal.timeout(240_000) });
    }
    rmSync(join(boardDir(board), ".tmp"), { recursive: true, force: true });
    const text = await r.text(); let d: any = {}; try { d = JSON.parse(text); } catch {}
    if (!r.ok) {
      const code = String(d?.error?.code ?? ""), msg = String(d?.error?.message ?? text);
      if (code === "insufficient_quota" || /billing|quota/i.test(msg)) throw new VizError(402, `OpenAI has no API credit left. ${OWNER_NAME} can add some at platform.openai.com/settings/organization/billing.`);
      if (/verif/i.test(msg)) throw new VizError(403, `OpenAI needs ${OWNER_NAME} to verify the organization first: platform.openai.com/settings/organization/general.`);
      if (code === "moderation_blocked" || /safety|moderation/i.test(msg)) throw new VizError(400, "OpenAI's content rules stopped this one.");
      throw new VizError(502, `OpenAI said ${r.status}: ${clip(msg, 160)}`);
    }
    const b64 = d?.data?.[0]?.b64_json; if (!b64) throw new VizError(502, "OpenAI sent no picture.");
    mkdirSync(genDir(board), { recursive: true });
    const name = `${jobId}-1.png`; await Bun.write(join(genDir(board), name), Buffer.from(b64, "base64"));
    return { files: [name], usd: openaiCost(d.usage) || (m.estimateUsd ?? 0.15) };
  }

  /** A picture to Higgsfield storage: HEIC and big files become a JPEG first. Returns its public URL. */
  async function upload(board: string, abs: string, tag: string): Promise<string> {
    let file = abs, ext = extname(abs).slice(1).toLowerCase();
    if (!["jpg", "jpeg", "png", "webp", "gif"].includes(ext) || statSync(abs).size > 8 * 1024 ** 2) {
      file = join(boardDir(board), ".tmp", `${tag}.jpg`); ext = "jpg";
      if (!(await sipsJpeg(abs, file, 2048, 88))) throw new VizError(500, "Couldn't convert a picture to send.");
    }
    const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext]!;
    const u = await hf("files/generate-upload-url", { method: "POST", body: JSON.stringify({ content_type: type }) });
    if (!/^https:\/\//.test(String(u.upload_url)) || !/^https:\/\//.test(String(u.public_url))) throw new VizError(502, "Higgsfield gave no upload address.");
    // The presigned storage address gets only its own headers, never our key.
    const put = await http(u.upload_url, { method: "PUT", headers: { "content-type": type, ...(u.upload_headers ?? {}) }, body: Bun.file(file), signal: AbortSignal.timeout(120_000) });
    if (file !== abs) rmSync(file, { force: true });
    if (!put.ok) throw new VizError(502, `Upload failed (${put.status}).`);
    return u.public_url;
  }

  async function download(board: string, jobId: string, urls: string[]): Promise<string[]> {
    const names: string[] = []; mkdirSync(genDir(board), { recursive: true });
    for (const [i, url] of urls.entries()) {
      if (!/^https:\/\//.test(url)) continue;
      const r = await http(url, { signal: AbortSignal.timeout(300_000) }); if (!r.ok) continue;
      const type = r.headers.get("content-type") ?? "";
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" } as Record<string, string>)[type.split(";")[0]]
        ?? (url.split("?")[0].match(/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i)?.[1].toLowerCase()) ?? "bin";
      if (ext === "bin") continue;
      const name = `${jobId}-${i + 1}.${ext}`; await Bun.write(join(genDir(board), name), await r.arrayBuffer()); names.push(name);
    }
    return names;
  }

  /** After the button press: write the prompt, then either send it (live) or make the preview (dry). */
  async function run(board: string, jobId: string, by: string) {
    working.add(jobId);
    try {
      const c = read(board); const job = c.jobs.find((j) => j.id === jobId); if (!job) return;
      const reuse = c.prompt.text && same(c.prompt.basis, basisOf(c)); // nothing new since the prompt: use it as it stands (hand edits too)
      const basis = basisOf(c), startVersion = c.prompt.version;
      const quick = job.model.startsWith("hfcli/") && job.edit !== false ? editPrompt(c, lastPicture(c, job)) : null; // an edit round: no drafting, straight out
      const d = quick ? { prompt: quick, negative: "", drafted: false } : reuse ? { prompt: c.prompt.text, negative: c.prompt.negative, drafted: c.prompt.drafted } : await draftPrompt(c, job.kind, chatFn, job.source);
      await change(board, (cc) => {
        opJob(cc, jobId, { prompt: d.prompt, negative: d.negative, drafted: d.drafted }, iso());
        if (!reuse && !quick && cc.prompt.version === startVersion) opSetPrompt(cc, { text: d.prompt, negative: d.negative, baseVersion: startVersion, drafted: d.drafted, basis }, by, iso());
      });
      const refs = c.refs.filter((r) => job.refs.includes(r.id));
      if (job.mode === "dry") {
        const done = { ...job, prompt: d.prompt, negative: d.negative, drafted: d.drafted };
        const name = await previewSheet(board, done, refs, `PREVIEW · nothing was sent out · ${job.kind === "video" ? "video" : "picture"}`);
        await change(board, (cc) => opJob(cc, jobId, { status: "preview", files: [name] }, iso()));
        say(`${board}: preview ${jobId} (${job.kind}${d.drafted ? "" : ", joined prompt"})`);
        return;
      }
      if (job.model.startsWith("hfcli/")) {
        const files = await cliPicture(board, job, d.prompt, refs);
        await settle(jobId, true, 0); // plan credits, not dollars
        await change(board, (cc) => opJob(cc, jobId, { status: "completed", files }, iso()));
        say(`${board}: ${jobId} done with Higgsfield (plan credits)`);
        return;
      }
      if (job.model === OPENAI_IMAGE.path) {
        const { files, usd } = await openaiPicture(board, jobId, d.prompt, refs);
        await settle(jobId, true, usd);
        await change(board, (cc) => opJob(cc, jobId, { status: "completed", files }, iso()));
        say(`${board}: ${jobId} done with OpenAI ($${usd})`);
        return;
      }
      const models = loadModels();
      const model = job.kind === "video" ? models.video : (job.model === models.imageRef?.path ? models.imageRef! : models.image);
      if (!goodPath(model.path)) throw new VizError(500, "The model setting is broken.");
      const body: Record<string, unknown> = { ...(model.params ?? {}), prompt: d.prompt };
      if (model.negativeField && d.negative) body[model.negativeField] = d.negative;
      if (job.kind === "video") {
        const src = refs.find((r) => r.id === job.source); if (!src?.file) throw new VizError(400, "The starting picture is gone.");
        body[model.imageField ?? "image_url"] = await upload(board, join(ROOT, src.file), `${jobId}-src`);
      } else if (model.refField) {
        const urls: string[] = []; for (const [i, r] of refs.filter((x) => x.file).slice(0, model.maxRefs ?? 1).entries()) urls.push(await upload(board, join(ROOT, r.file!), `${jobId}-${i}`));
        if (urls.length) body[model.refField] = model.refArray ? urls : urls[0];
      }
      const res = await hf(model.path, { method: "POST", body: JSON.stringify(body), idem: jobId });
      if (!res.request_id) throw new VizError(502, "Higgsfield didn't take it.");
      const statusUrl = String(res.status_url ?? "").startsWith(`${API}/requests/`) ? String(res.status_url) : `${API}/requests/${encodeURIComponent(res.request_id)}/status`;
      await change(board, (cc) => opJob(cc, jobId, { status: res.status === "in_progress" ? "in_progress" : "queued", requestId: String(res.request_id), statusUrl }, iso()));
      open.set(jobId, { board, job: jobId });
      say(`${board}: sent ${jobId} (${job.kind}, ${model.path}, about $${job.estimateUsd})`);
    } catch (e) {
      const msg = e instanceof VizError ? e.message : "Something went wrong making this one.";
      say(`${board}: ${jobId} failed before sending: ${String((e as Error).message).slice(0, 200)}`);
      await settle(jobId, false).catch(() => {});
      await change(board, (cc) => opJob(cc, jobId, { status: "failed", error: msg }, iso())).catch(() => {});
    } finally { working.delete(jobId); }
  }

  /** One pass over live jobs at Higgsfield (the server runs this every ~3 s). */
  async function pollOnce() {
    for (const [key, { board, job: jobId }] of [...open]) {
      let job: Job | undefined; try { job = read(board).jobs.find((j) => j.id === jobId); } catch { continue; }
      if (!job || !OPEN.includes(job.status) || !job.statusUrl) { open.delete(key); continue; }
      try {
        const s = await hf(job.statusUrl);
        const st = String(s.status ?? "");
        if (st === "completed") {
          const urls = [...(s.images ?? []).map((x: any) => String(x?.url ?? "")), s.video?.url ? String(s.video.url) : ""].filter(Boolean);
          const files = await download(board, jobId, urls);
          await settle(jobId, true);
          await change(board, (c) => opJob(c, jobId, files.length ? { status: "completed", files } : { status: "failed", error: "It finished, but the result couldn't be downloaded." }, iso()));
          open.delete(key); say(`${board}: ${jobId} done (${files.length} file${files.length === 1 ? "" : "s"})`);
        } else if (st === "failed" || st === "nsfw" || st === "canceled") {
          await settle(jobId, false); // Higgsfield doesn't charge these
          const error = st === "nsfw" ? "Higgsfield's content rules stopped this one." : st === "canceled" ? "Canceled." : clip(scrub(String(s.error?.message ?? s.error ?? "Higgsfield couldn't make this one.")), 200);
          await change(board, (c) => opJob(c, jobId, { status: st as JobStatus, error }, iso()));
          open.delete(key);
        } else if (st === "in_progress" && job.status !== "in_progress") await change(board, (c) => opJob(c, jobId, { status: "in_progress" }, iso()));
        else if (now() - Date.parse(job.created) > 45 * 60_000) {
          await settle(jobId, true); // it may still be charged, so it counts against the cap
          await change(board, (c) => opJob(c, jobId, { status: "failed", error: "This one took too long. It may still be charged." }, iso()));
          open.delete(key);
        }
      } catch (e) { say(`${board}: status for ${jobId}: ${String((e as Error).message).slice(0, 160)}`); }
    }
  }

  /** On start: pick live jobs back up, and close any that were drafting when the app stopped. */
  async function resume() {
    const root = join(ROOT, "library/boards"); if (!existsSync(root)) return;
    for (const b of (await Array.fromAsync(new Bun.Glob("*/canvas.json").scan({ cwd: root }))).map((p) => p.split("/")[0]).filter((b) => BOARD_RE.test(b))) {
      let c: Canvas; try { c = read(b); } catch { continue; }
      for (const j of c.jobs) {
        if ((j.status === "queued" || j.status === "in_progress") && j.statusUrl) open.set(j.id, { board: b, job: j.id });
        else if (j.status === "drafting" && !working.has(j.id)) { await settle(j.id, false).catch(() => {}); await change(b, (cc) => opJob(cc, j.id, { status: "failed", error: "Interrupted. Try again." }, iso())); }
      }
    }
  }

  // ── Operations as the routes call them ──
  async function gate(p: Person, board: unknown): Promise<string> {
    const b = String(board ?? ""); if (!BOARD_RE.test(b)) throw new VizError(400, "Which board?");
    if (!(await deps.canSee(p.id, b))) throw new VizError(403, "This board isn't shared with you.");
    return b;
  }
  function view(c: Canvas) {
    const m = modeNow(keyFile), b = readBudget();
    return { version: c.version, board: c.board, mode: m.live ? "live" : "dry", why: m.why,
      budget: b ? { capUsd: b.capUsd, spentUsd: b.spentUsd, reservedUsd: reservedUsd(b) } : null,
      refs: active(c.refs).map(({ id, item, title, kind, summary, notes, by, addedBy, at, file }) => ({ id, item, title, kind, summary, notes, by, addedBy, at, picture: !!file })),
      words: active(c.words), prompt: { text: c.prompt.text, negative: c.prompt.negative, by: c.prompt.by, version: c.prompt.version, drafted: c.prompt.drafted },
      jobs: c.jobs.filter((j) => shown(c, j)).slice(-30).reverse().map(({ statusUrl, requestId, ...j }) => j), kept: c.kept.slice(-50),
      limits: { running: runningJobs(c), maxRunning: MAX_RUNNING, lastHour: jobsLastHour(c, now()), perHour: MAX_PER_HOUR } };
  }
  const ops = {
    async state(p: Person, board: unknown, since?: number) { const b = await gate(p, board); const c = read(b); return since === c.version ? null : view(c); },
    async addRef(p: Person, board: unknown, itemId: unknown) {
      const b = await gate(p, board); const id = String(itemId ?? "").slice(0, 300); if (!id) throw new VizError(400, "Nothing was dropped.");
      const info = await resolveItem(p, id); if (!info) throw new VizError(404, "That one can't be used here (it's private, or not on the board).");
      return change(b, (c) => opAddRef(c, info, p.name, iso()));
    },
    async removeRef(p: Person, board: unknown, refId: unknown) { const b = await gate(p, board); await change(b, (c) => opRemoveRef(c, String(refId), p.name, iso())); },
    async addWords(p: Person, board: unknown, text: unknown) { const b = await gate(p, board); return change(b, (c) => opAddWords(c, String(text ?? ""), p.name, iso())); },
    async clear(p: Person, board: unknown) { const b = await gate(p, board); await change(b, (c) => opClear(c, p.name, iso())); },
    async removeWords(p: Person, board: unknown, id: unknown) { const b = await gate(p, board); await change(b, (c) => opRemoveWords(c, String(id), p.name, iso())); },
    async setPrompt(p: Person, board: unknown, text: unknown, negative: unknown, baseVersion: unknown) {
      const b = await gate(p, board);
      return change(b, (c) => opSetPrompt(c, { text: String(text ?? ""), negative: negative == null ? undefined : String(negative), baseVersion: Number(baseVersion) }, p.name, iso()));
    },
    async generate(p: Person, board: unknown, kind: unknown, source?: unknown, choice?: unknown, edit?: unknown) {
      const b = await gate(p, board);
      const k = kind === "video" ? "video" : "image";
      const c0 = read(b);
      const src = k === "video" ? (active(c0.refs).find((r) => r.id === source && r.file) ?? active(c0.refs).find((r) => r.file)) : undefined;
      if (k === "video" && !src) throw new VizError(400, "A video starts from a picture: drag one in first.");
      if (working.size + open.size >= MAX_RUNNING) throw new VizError(429, "Two are already being made. Wait for one to finish.");
      const m = modeNow(keyFile, k), models = loadModels();
      const model = k === "image" && usesCli(k) ? pickModel(c0, choice, edit !== false) : k === "image" && usesOpenAI(k) ? OPENAI_IMAGE : k === "video" ? models.video : (models.imageRef && active(c0.refs).some((r) => r.file) ? models.imageRef : models.image);
      const usd = model.path.startsWith("hfcli/") ? 0 : model === OPENAI_IMAGE ? OPENAI_IMAGE.estimateUsd! : await estimate(model, m.live);
      const jobId = `${new Date(now()).toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
      if (m.live) await reserve(jobId, usd); // 402 over the cap, before anything is made
      let job: Job;
      try { job = await change(b, (c) => opGenerate(c, { id: jobId, kind: k, mode: m.live ? "live" : "dry", model: model.path, label: model.label, edit: edit !== false, source: src?.id, estimateUsd: m.live ? usd : 0, by: p.name, created: iso() }, now())); }
      catch (e) { if (m.live) await settle(jobId, false); throw e; }
      if (!m.live) say(`${b}: dry mode (${m.why.join(", ")})`);
      run(b, jobId, p.name); // in the background; everyone sees it move through the polls
      return job;
    },
    async keep(p: Person, board: unknown, jobId: unknown, file: unknown, project: unknown) {
      const b = await gate(p, board);
      const c = read(b); const job = c.jobs.find((j) => j.id === jobId);
      if (!job || !(job.status === "completed" || job.status === "preview")) throw new VizError(404, "That result isn't ready.");
      const name = String(file ?? job.files[0] ?? ""); if (!job.files.includes(name) || !FILE_RE.test(name)) throw new VizError(404, "That result isn't there.");
      const proj = String(project ?? "").trim(); if (!proj) throw new VizError(400, "Pick a project to keep it in.");
      const refs = c.refs.filter((r) => job.refs.includes(r.id)).map((r) => `"${r.title}"${r.by ? ` (${r.by})` : ""}`);
      const voices = [...new Set(active(c.words).filter((w) => Date.parse(w.at) <= Date.parse(job.created)).map((w) => w.by))];
      const from = [refs.length ? refs.join(", ") : "", voices.length ? `words by ${voices.join(", ")}` : ""].filter(Boolean).join(", with ");
      const notes = `${job.prompt}\n\n${job.mode === "dry" ? "Preview made in Recall (nothing was sent out)" : job.model === OPENAI_IMAGE.path ? "Made with OpenAI" : "Made with Higgsfield"}${from ? ` from ${from}` : ""}.`;
      const saved = await deps.queueSave(p, { notes, files: [join(genDir(b), name)], project: proj });
      await change(b, (cc) => opKeep(cc, { job: job.id, file: name, by: p.name, project: proj, save: saved.id, at: iso() }));
      say(`${b}: ${p.id} kept ${name} into ${proj}`);
      return { save: saved.id };
    },
    async file(p: Person, board: unknown, name: unknown): Promise<Response> {
      const b = await gate(p, board); const n = String(name ?? "");
      if (!FILE_RE.test(n) || !existsSync(join(genDir(b), n))) return new Response("not found", { status: 404 });
      const svg = n.endsWith(".svg");
      return new Response(Bun.file(join(genDir(b), n)), { headers: { "cache-control": "private, max-age=86400", ...(svg ? { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'" } : {}) } });
    },
    async refImage(p: Person, board: unknown, refId: unknown): Promise<Response> {
      const b = await gate(p, board); const r = active(read(b).refs).find((x) => x.id === refId);
      if (!r?.file) return new Response("not found", { status: 404 });
      const out = join(boardDir(b), ".thumbs", `${r.id}.jpg`);
      if (!existsSync(out) && !(await sipsJpeg(join(ROOT, r.file), out, 480, 72))) return new Response("not found", { status: 404 });
      return new Response(Bun.file(out), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
    },
  };

  return { ops, pollOnce, resume, open, working };
}

/** The routes to spread into server.ts's `routes`. Starts the Higgsfield poller. */
export function visualizeRoutes(withPerson: WithPerson, deps: Deps) {
  const v = createVisualize(deps);
  v.resume().catch((e) => console.error(`[visualize] resume: ${String(e).slice(0, 160)}`));
  const tick = () => setTimeout(() => v.pollOnce().catch(() => {}).finally(tick), 3000 + Math.random() * 600); // ~3 s with jitter
  tick();
  const handle = (fn: (req: Request, p: Person, q: URLSearchParams, b: any) => Promise<Response>) => withPerson(async (req, p) => {
    try {
      const q = new URL(req.url).searchParams;
      const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return await fn(req, p, q, b);
    } catch (e) {
      if (e instanceof VizError) return json({ error: e.message }, e.status);
      if (e instanceof SyntaxError) return json({ error: `Something's wrong with this board's file. Tell ${OWNER_NAME}.` }, 500);
      console.error(`[visualize] ${String((e as Error).message ?? e).slice(0, 200)}`);
      return json({ error: "Something went wrong." }, 500);
    }
  });
  return {
    "/api/visualize/state": { GET: handle(async (_r, p, q) => { const s = await v.ops.state(p, q.get("board"), q.has("since") ? Number(q.get("since")) : undefined); return s ? json(s) : new Response(null, { status: 204 }); }) },
    "/api/visualize/ref": { POST: handle(async (_r, p, _q, b) => { const { file, ...ref } = await v.ops.addRef(p, b.board, b.id); return json({ ok: true, ref: { ...ref, picture: !!file } }); }) }, // file paths stay on the server
    "/api/visualize/ref/remove": { POST: handle(async (_r, p, _q, b) => { await v.ops.removeRef(p, b.board, b.ref); return json({ ok: true }); }) },
    "/api/visualize/words": { POST: handle(async (_r, p, _q, b) => json({ ok: true, words: await v.ops.addWords(p, b.board, b.text) })) },
    "/api/visualize/clear": { POST: handle(async (_r, p, _q, b) => { await v.ops.clear(p, b.board); return json({ ok: true }); }) },
    "/api/visualize/words/remove": { POST: handle(async (_r, p, _q, b) => { await v.ops.removeWords(p, b.board, b.id); return json({ ok: true }); }) },
    "/api/visualize/prompt": { POST: handle(async (_r, p, _q, b) => json({ ok: true, prompt: await v.ops.setPrompt(p, b.board, b.text, b.negative, b.baseVersion) })) },
    "/api/visualize/generate": { POST: handle(async (_r, p, _q, b) => json({ ok: true, job: await v.ops.generate(p, b.board, b.kind, b.source, b.model, b.edit) }, 202)) },
    "/api/visualize/keep": { POST: handle(async (_r, p, _q, b) => json({ ok: true, ...(await v.ops.keep(p, b.board, b.job, b.file, b.project)) })) },
    "/api/visualize/file": { GET: handle(async (_r, p, q) => v.ops.file(p, q.get("board"), q.get("name"))) },
    "/api/visualize/ref-image": { GET: handle(async (_r, p, q) => v.ops.refImage(p, q.get("board"), q.get("ref"))) },
  };
}

/** Until team boards land: anyone signed in may use the one board, "default". */
export const defaultCanSee = (_personId: string, boardId: string) => boardId === "default";
