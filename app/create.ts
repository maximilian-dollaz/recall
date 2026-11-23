// Create (a project's Create tab): pick assets, say how and why, and it is made in a queue.
// This is the first shape of the creative engine: from what was saved (a filmed video, pictures on a board)
// to something ready to post, as fast as possible, without the person waiting on it.
//
//   board-video   the chosen pictures as one short upright video (1080x1920), a few seconds each
//   reel          the chosen video made post-ready: upright 1080x1920, sound levelled for phones, quick to start
//   post          the chosen pictures as a set sized for a feed post (1080x1350), up to ten
//
// What it never does: write a caption or any words that go out under the person's name. The note ("how and
// why") is kept with the job for the person and for whoever finishes it. Pictures made from words (Creator
// mode, visualize.ts) are a separate, live tool; this queue only reshapes what the person already saved.
// Everything is made with ffmpeg on this server, one job at a time, at low priority. Nothing leaves Recall
// until the person sends it (a draft in a scheduling tool, never a published post).
// One ledger per person (<dir>/create.json); what was made sits in <dir>/created/<job id>/.

import { join, resolve, extname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import * as store from "./store.ts";
import { DATA } from "./paths.ts";
import { jpegArgs } from "./img.ts";
import { scanPages } from "./projects.ts";
import type { Person } from "./identity.ts";

export type Format = "board-video" | "reel" | "post";
export type Status = "queued" | "making" | "ready" | "failed";
export type Job = {
  id: string; project: string; projectName: string; format: Format; brief: string;
  items: { id: string; title: string; kind: string; files: string[] }[];
  status: Status; out: string[]; error?: string; created: string; updated: string;
  sent?: { to: string; at: string; note: string };
};
type Ledger = { jobs: Job[] };

export const FORMATS: Record<Format, { name: string; what: string }> = {
  "board-video": { name: "Board video", what: "The pictures you picked as one short upright video." },
  reel: { name: "Reel", what: "The video you picked, made ready to post: upright, sound levelled." },
  post: { name: "Post pictures", what: "The pictures you picked, sized for a feed post (up to ten)." },
};
const IMG = /\.(jpe?g|png|webp|gif|heic|heif)$/i, VID = /\.(mp4|mov|m4v|webm)$/i;
const MAX_VIDEO_BYTES = 600 * 1024 ** 2;   // a longer source is a job for a real editor, not this server
const SECONDS_EACH = 2.6;                  // one picture in a board video
const BG = "0x0E1519";                     // the dusk behind a picture that isn't upright
const KEEP = 60;
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg" };

const file = (dir: string) => join(dir, "create.json");
const empty = (): Ledger => ({ jobs: [] });
export function ledger(dir: string): Ledger { try { return store.read<Ledger>(file(dir), empty()); } catch { return empty(); } }
const change = (dir: string, fn: (l: Ledger) => void) => store.update<Ledger>(file(dir), empty(), (l) => { fn(l); return l; });
const outDir = (dir: string, id: string) => join(dir, "created", id);
const now = () => new Date().toISOString();

export const list = (dir: string, project?: string) => ledger(dir).jobs.filter((j) => !project || j.project === project).sort((a, b) => b.created.localeCompare(a.created));

/** A saved file's real place on disk, only when it is inside this person's own library. */
function ownFile(p: Person, rel: string): string | null {
  const abs = resolve(join(DATA, rel));
  return (abs.startsWith(join(p.dir, "files") + "/") || abs.startsWith(join(p.dir, "vault") + "/")) && existsSync(abs) ? abs : null;
}

/** Add a job. It says plainly when the picked items can't make that format. */
export async function add(p: Person, input: { project: string; projectName: string; format: Format; brief: string; items: string[] }): Promise<Job | { error: string }> {
  if (!Object.hasOwn(FORMATS, input.format)) return { error: "Pick what to make." };
  const want = new Set(input.items);
  const items = scanPages(p.dir).filter((it) => want.has(it.id)).map((it) => ({ id: it.id, title: it.title, kind: it.kind, files: it.files }));
  // In the order they were picked.
  items.sort((a, b) => input.items.indexOf(a.id) - input.items.indexOf(b.id));
  const has = (re: RegExp) => items.some((it) => it.files.some((f) => re.test(f)));
  if (!items.length) return { error: "Pick something first." };
  if (input.format === "reel" && !has(VID)) return { error: "A reel needs a video. Pick one you saved." };
  if (input.format !== "reel" && !has(IMG)) return { error: "That needs pictures. Pick at least one." };
  const job: Job = { id: Math.random().toString(36).slice(2, 10), project: input.project, projectName: input.projectName.slice(0, 80), format: input.format, brief: input.brief.replace(/\s+\n/g, "\n").trim().slice(0, 1500),
    items, status: "queued", out: [], created: now(), updated: now() };
  await change(p.dir, (l) => {
    l.jobs.push(job);
    // Past KEEP, the oldest finished ones go (never one waiting or being made).
    while (l.jobs.length > KEEP) { const i = l.jobs.findIndex((j) => j.status === "ready" || j.status === "failed"); if (i < 0) break; rmSync(outDir(p.dir, l.jobs[i].id), { recursive: true, force: true }); l.jobs.splice(i, 1); }
  });
  return job;
}

export async function remove(p: Person, id: string) {
  let ok = false;
  await change(p.dir, (l) => { const i = l.jobs.findIndex((j) => j.id === id); if (i >= 0 && l.jobs[i].status !== "making") { l.jobs.splice(i, 1); ok = true; } });
  if (ok) rmSync(outDir(p.dir, id), { recursive: true, force: true });
  return ok;
}

/** One made file, for the person who owns the job. */
export function made(p: Person, id: string, n: number): string | null {
  const j = ledger(p.dir).jobs.find((x) => x.id === id); const name = j?.out[n]; if (!name || /[\/\\]/.test(name)) return null;
  const abs = join(outDir(p.dir, id), name); return existsSync(abs) ? abs : null;
}
export async function markSent(p: Person, id: string, to: string, note: string) { await change(p.dir, (l) => { const j = l.jobs.find((x) => x.id === id); if (j) { j.sent = { to, at: now(), note }; j.updated = now(); } }); }

// ── Links a scheduling tool can fetch ──
// A scheduling tool pulls media from a web address, so a made file gets a long unguessable link for a week:
// /c/<token>/<n>. Only made files are ever served this way, never anything else in the library.
type Link = { dir: string; id: string; until: string };
const LINKS = join(DATA, "created-links.json");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function publish(p: Person, id: string, base: string): Promise<string[]> {
  const job = ledger(p.dir).jobs.find((j) => j.id === id && j.status === "ready"); if (!job) return [];
  const token = randomBytes(24).toString("base64url");
  await store.update<Record<string, Link>>(LINKS, {}, (l) => { for (const k of Object.keys(l)) if (Date.parse(l[k].until) < Date.now()) delete l[k]; l[hash(token)] = { dir: p.dir, id, until: new Date(Date.now() + 7 * 864e5).toISOString() }; return l; });
  return job.out.map((name, n) => `${base}/c/${token}/${n}${extname(name)}`);
}
export async function door(req: Request): Promise<Response | null> {
  const m = new URL(req.url).pathname.match(/^\/c\/([A-Za-z0-9_-]{20,64})\/(\d{1,2})(?:\.[a-z0-9]{2,4})?$/); if (!m || req.method !== "GET") return null;
  const gone = new Response("This link has stopped working.", { status: 404, headers: { "x-robots-tag": "noindex" } });
  let l: Link | undefined; try { l = store.read<Record<string, Link>>(LINKS, {})[hash(m[1])]; } catch {}
  if (!l || Date.parse(l.until) < Date.now()) return gone;
  const name = ledger(l.dir).jobs.find((j) => j.id === l!.id)?.out[+m[2]]; if (!name || /[\/\\]/.test(name)) return gone;
  const abs = join(outDir(l.dir, l.id), name); if (!existsSync(abs)) return gone;
  return new Response(Bun.file(abs), { headers: { "content-type": TYPES[extname(abs)] ?? "application/octet-stream", "x-robots-tag": "noindex, nofollow", "cache-control": "private, max-age=3600" } });
}

// ── Making ──
async function run(args: string[], ms = 20 * 60_000): Promise<void> {
  const p = Bun.spawn(["nice", "-n", "10", ...args], { stdout: "ignore", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), ms);
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]); clearTimeout(t);
  if (code !== 0) throw new Error(err.trim().split("\n").slice(-2).join(" ").slice(0, 240) || `exit ${code}`);
}
const pad = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1`;

/** Each picked picture as an upright or feed-sized JPEG in the job's folder; returns their names in order. */
async function frames(p: Person, job: Job, dir: string, w: number, h: number, max: number, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const srcs = job.items.flatMap((it) => it.files.filter((f) => IMG.test(f)).slice(0, 1)).map((f) => ownFile(p, f)).filter(Boolean) as string[];
  for (const src of srcs.slice(0, max)) {
    const n = String(out.length + 1).padStart(3, "0"), tmp = join(dir, `.src-${n}.jpg`), name = `${prefix}-${n}.jpg`;
    // Through the picture tool first: it reads HEIC and turns a photo the right way up.
    await run(jpegArgs(src, tmp, 2160, 90), 60_000).catch(() => {});
    await run(["ffmpeg", "-v", "error", "-y", "-i", existsSync(tmp) ? tmp : src, "-vf", pad(w, h), "-frames:v", "1", "-q:v", "3", join(dir, name)], 60_000);
    rmSync(tmp, { force: true }); out.push(name);
  }
  return out;
}

async function make(p: Person, job: Job): Promise<string[]> {
  const dir = outDir(p.dir, job.id); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  if (job.format === "post") {
    const pics = await frames(p, job, dir, 1080, 1350, 10, "post"); if (!pics.length) throw new Error("None of those pictures could be read.");
    return pics;
  }
  if (job.format === "board-video") {
    const pics = await frames(p, job, dir, 1080, 1920, 30, "f"); if (!pics.length) throw new Error("None of those pictures could be read.");
    await run(["ffmpeg", "-v", "error", "-y", "-framerate", String(1 / SECONDS_EACH), "-i", join(dir, "f-%03d.jpg"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart", join(dir, "board.mp4")]);
    for (const f of pics) rmSync(join(dir, f), { force: true });
    return ["board.mp4"];
  }
  // reel: the first video among the picked items
  const rel = job.items.flatMap((it) => it.files).find((f) => VID.test(f)); const src = rel && ownFile(p, rel);
  if (!src) throw new Error("That video isn't in your library any more.");
  if (statSync(src).size > MAX_VIDEO_BYTES) throw new Error("That video is too large to make here (over 600 MB). Trim it first.");
  const base = ["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", `${pad(1080, 1920)},fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart"];
  // Sound levelled for phones at 48 kHz (loudnorm raises the rate by itself); a clip with no sound is made without it.
  const probe = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src], { stdout: "pipe", stderr: "ignore" });
  const hasAudio = (await new Response(probe.stdout).text()).trim() !== "";
  await run([...base, ...(hasAudio ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "160k"] : ["-an"]), join(dir, "reel.mp4")], 45 * 60_000);
  return ["reel.mp4"];
}

let busy = false;
/** The queue: one job at a time for everyone. A job cut short by a restart is made again. */
export async function drain(people: () => Promise<Person[]>) {
  if (busy) return; busy = true;
  try {
    for (const p of await people()) {
      for (let n = 0; n < 10; n++) {
        let job: Job | undefined;
        await change(p.dir, (l) => { const j = l.jobs.find((x) => x.status === "queued"); if (j) { j.status = "making"; j.updated = now(); job = structuredClone(j); } });
        if (!job) break;
        let out: string[] = [], error: string | undefined;
        try { out = await make(p, job); } catch (e) { error = String((e as Error).message ?? e).slice(0, 240); console.error(`[create] ${p.id}: ${job.format} ${job.id} failed: ${error}`); }
        await change(p.dir, (l) => { const j = l.jobs.find((x) => x.id === job!.id); if (!j) return; j.status = error ? "failed" : "ready"; j.out = out; j.error = error; j.updated = now(); });
        if (!error) console.log(`[create] ${p.id}: made ${job.format} ${job.id} for ${job.project} (${out.length} file${out.length === 1 ? "" : "s"})`);
      }
    }
  } finally { busy = false; }
}
export async function recover(people: () => Promise<Person[]>) {
  for (const p of await people()) if (existsSync(file(p.dir))) await change(p.dir, (l) => { for (const j of l.jobs) if (j.status === "making") j.status = "queued"; }).catch(() => {});
}

// ── Routes ──
type With = (fn: (req: Request, p: Person) => Promise<Response>) => (req: Request) => Promise<Response>;
const json = (d: unknown, status = 200) => Response.json(d, { status });
export function createRoutes(withPerson: With, deps: { kick: () => void; projectName: (id: string) => Promise<string | null>;
  canSend: () => boolean; send: (p: Person, job: Job, body: { caption: string; networks: string[] }) => Promise<{ ok?: boolean; error?: string; note?: string }>;
  canCanva: (p: Person) => boolean; toCanva: (p: Person, file: string, name: string) => Promise<{ ok?: boolean; error?: string }> }) {
  return {
    "/api/create": {
      GET: withPerson(async (req, p) => json({ jobs: list(p.dir, new URL(req.url).searchParams.get("project") ?? undefined), formats: FORMATS, canSend: deps.canSend(), canCanva: deps.canCanva(p) })),
      POST: withPerson(async (req, p) => {
        const b = (await req.json().catch(() => ({}))) as any; const project = String(b.project ?? "");
        const name = await deps.projectName(project); if (!name) return json({ error: "That project isn't available." }, 404);
        const r = await add(p, { project, projectName: name, format: b.format, brief: String(b.brief ?? ""), items: (Array.isArray(b.items) ? b.items : []).map(String).slice(0, 40) });
        if ("error" in r) return json(r, 400);
        deps.kick(); return json(r);
      }),
    },
    "/api/create/file": withPerson(async (req, p) => {
      const u = new URL(req.url); const abs = made(p, u.searchParams.get("id") ?? "", Number(u.searchParams.get("n") ?? 0));
      if (!abs) return new Response("not found", { status: 404 });
      const dl = u.searchParams.get("dl") ? { "content-disposition": `attachment; filename="${abs.split("/").pop()}"` } : {};
      return new Response(Bun.file(abs), { headers: { "content-type": TYPES[extname(abs)] ?? "application/octet-stream", "cache-control": "private, max-age=3600", ...dl } });
    }),
    "/api/create/remove": { POST: withPerson(async (req, p) => { const b = (await req.json().catch(() => ({}))) as any; return json({ ok: await remove(p, String(b.id)) }); }) },
    // Send what was made to the scheduling tool as a DRAFT, with the caption the person wrote (never one written here).
    "/api/create/send": { POST: withPerson(async (req, p) => {
      const b = (await req.json().catch(() => ({}))) as any; const job = ledger(p.dir).jobs.find((j) => j.id === String(b.id));
      if (!job || job.status !== "ready") return json({ error: "That one isn't ready." }, 404);
      if (!deps.canSend()) return json({ error: "Connect a scheduling tool first.", connect: "/connectors" }, 409);
      const networks = (Array.isArray(b.networks) ? b.networks : []).map(String); if (!networks.length) return json({ error: "Pick where it goes." }, 400);
      const r = await deps.send(p, job, { caption: String(b.caption ?? ""), networks });
      if (r.ok) await markSent(p, job.id, "metricool", r.note ?? "Saved as a draft.");
      return json(r, r.ok ? 200 : 400);
    }) },
    // Put what was made into the person's Canva uploads, to finish it there.
    "/api/create/canva": { POST: withPerson(async (req, p) => {
      const b = (await req.json().catch(() => ({}))) as any; const job = ledger(p.dir).jobs.find((j) => j.id === String(b.id));
      if (!job || job.status !== "ready") return json({ error: "That one isn't ready." }, 404);
      if (!deps.canCanva(p)) return json({ error: "Connect Canva first.", connect: "/connectors" }, 409);
      let sent = 0, error = "";
      for (let n = 0; n < job.out.length; n++) { const abs = made(p, job.id, n); if (!abs) continue; const r = await deps.toCanva(p, abs, `${job.projectName} ${FORMATS[job.format].name} ${n + 1}`.slice(0, 50)); if (r.ok) sent++; else error = r.error ?? "Canva didn't take it."; }
      return sent ? json({ ok: true, note: `${sent} file${sent === 1 ? "" : "s"} in your Canva uploads.` }) : json({ error: error || "Nothing to send." }, 400);
    }) },
  };
}
