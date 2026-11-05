// Context Library app: one page to save anything, one page to find it again.
// http://localhost:3344 on this Mac; phones reach it over the private network.
//
// Each person (identified by their phone on the private network) has their own
// library: a GBrain source, a files folder, a vault, and reminders.
// Saving is instant: the item is stored and acknowledged, and the librarian
// (vision, OCR, transcription, filing) works through a queue in the background.

import { join, dirname, basename } from "node:path";
import { lookup } from "node:dns/promises";
import { mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync, renameSync, statfsSync, statSync, rmSync, copyFileSync } from "node:fs";
import * as gb from "./gbrain.ts";
import { file as fileItem, loadCatalog, updateCatalog, noteProposal, chat } from "./librarian.ts";
import { extractFile, extractUrl, stripSecrets, nameFor } from "./extract.ts";
import { vaultFor } from "./vault.ts";
import { addReminder, setState as setReminderState, renameReminder, removeReminder, due as dueReminders, dueDate, describe as describeReminder, parseWhen, namedProject } from "./reminders.ts";
import { whoIs, setWelcomed, deviceKind, listPeople, type Person } from "./identity.ts";
import { keysPage, saveServiceKey } from "./service-keys.ts";
import * as projects from "./projects.ts";
import { isSoulPath, soulProxy } from "./soul.ts";
import * as topics from "./topics.ts";
import * as cues from "./cues.ts";
import { join_ as joinDoor, joinPage, sessionEmail } from "./door.ts";
import { teamEntry, googleSignIn, signInPage, privacyPage } from "./google.ts";
import * as boards from "./board.ts";
import { boardRoutes, boardDoor } from "./boards-routes.ts";
import { findRoutes } from "./recent.ts";
import * as dupes from "./dupes.ts";
import * as pieces from "./pieces.ts";
import * as trash from "./trash.ts";
import { visualizeRoutes } from "./visualize.ts";
import { mintKey, emailForKey } from "./keys.ts";
import * as deepgram from "./deepgram.ts";

import { CODE, DATA as ROOT, PORTS, TWIN } from "./paths.ts";
import { PUBLIC_URL as CONFIG_URL, PUBLIC_HOST, OWNER_NAME, TAILNET_HOST } from "./config.ts";
// Files that get a picture on their tile: photos, and videos (a frame from them).
const VISUAL = /\.(png|jpe?g|gif|webp|heic|mp4|mov|m4v|webm)$/i;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }; // local date, not UTC
const json = (data: unknown, status = 400) => Response.json(data, { status });
const recent = new Map<string, string[]>(); // per person: recent searches (for "when we work on X")

// ── Pages ──────────────────────────────────────────────────────────────────
function pageMarkdown(f: { title: string; type: string; shelf: string; tags: string[]; summary: string; notes: string; body: string; files: string[]; url?: string; kind: string; state?: string; bring_back?: string; bring_back_when?: string; saved_by?: string; project?: string; batch?: string; duplicate_of?: string }) {
  const fm = [
    "---",
    `title: ${JSON.stringify(f.title)}`,
    `type: ${f.type}`,
    `shelf: ${f.shelf}`,
    f.project ? `project: ${f.project}` : null,
    f.batch ? `batch: ${f.batch}` : null,
    f.duplicate_of ? `duplicate_of: ${f.duplicate_of}` : null,
    `kind: ${f.kind}`,
    `state: ${f.state ?? "idea"}`,
    f.bring_back ? `bring_back: ${f.bring_back}` : null,
    f.bring_back_when ? `bring_back_when: ${JSON.stringify(f.bring_back_when)}` : null,
    `tags: [${f.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `saved: ${today()}`,
    `saved_at: ${new Date().toISOString()}`,
    `saved_via: app`,
    f.saved_by ? `saved_by: ${JSON.stringify(f.saved_by)}` : null,
    f.url ? `url: ${f.url}` : null,
    f.files.length ? `files: [${f.files.map((x) => JSON.stringify(x)).join(", ")}]` : null,
    "---",
  ].filter(Boolean).join("\n");
  const parts = [fm, "", f.summary ? `> ${f.summary}` : "", ""];
  if (f.notes) parts.push("## Why I saved this", "", f.notes, "");
  if (f.files.length) parts.push("## Attached", "", ...f.files.map((x) => `- ${x}`), "");
  if (f.body) parts.push(f.kind === "image" || f.kind === "video" ? "## What the picture shows" : "## Content", "", f.body, "");
  return parts.join("\n");
}

// ── Save: instant acknowledge, background filing ───────────────────────────
type Job = { id: string; person: string; notes: string; url: string; keepLocal: boolean; remind: string; remindWhen: string; who: string; files: string[]; created: string; attempts?: number; privacyDecided?: boolean; project?: string; batch?: string; title?: string };
// Behind the person's Google sign-in: fetched from here, these are only ever the sign-in page.
const SIGNED_IN = /^https:\/\/(docs|drive)\.google\.com\//i;

function inboxDir(p: Person) { const d = join(p.dir, "inbox"); mkdirSync(d, { recursive: true }); return d; }

// Fetching what people drop from the web. Only public addresses: never this Mac or the local network.
async function publicUrl(raw: string): Promise<URL | null> {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  try {
    const { address } = await lookup(u.hostname);
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) || /^(::1|::|f[cd]|fe80)/i.test(address)) return null;
  } catch { return null; }
  return u;
}
async function safeFetch(raw: string, ms: number): Promise<Response | null> {
  let next = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicUrl(next); if (!u) return null;
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(ms), headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", accept: "text/html,image/*,*/*" } }).catch(() => null);
    if (!r) return null;
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { next = new URL(r.headers.get("location")!, u).toString(); continue; }
    return r.ok ? r : null;
  }
  return null;
}
/** Download an image from the web into dir. Returns the path, or null if it isn't a reachable image. */
/** Download an image from the web into dir. Pinterest: the full original first, its 736x copy if there is none. */
async function fetchImage(src: string, dir: string, name: string): Promise<string | null> {
  const pin = src.match(/^(https:\/\/i\.pinimg\.com)\/(?:\d{2,4}x|originals)\/(.+)$/);
  if (pin) for (const size of ["originals", "736x"]) { const p = await fetchImageOnce(`${pin[1]}/${size}/${pin[2]}`, dir, name); if (p) return p; }
  return fetchImageOnce(src, dir, name);
}
async function fetchImageOnce(src: string, dir: string, name: string): Promise<string | null> {
  const r = await safeFetch(src, 10_000); if (!r) return null;
  const type = r.headers.get("content-type") ?? ""; if (!type.startsWith("image/")) return null;
  const buf = await r.arrayBuffer().catch(() => null); if (!buf || buf.byteLength > 25 * 1024 ** 2 || buf.byteLength < 200) return null;
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/avif": "avif" } as Record<string, string>)[type.split(";")[0]] ?? "jpg";
  mkdirSync(dir, { recursive: true }); const p = join(dir, `${name}.${ext}`); await Bun.write(p, buf); return p;
}
/** A page's preview picture (og:image / twitter:image), if it has one. */
async function previewImage(page: string): Promise<string | null> {
  const r = await safeFetch(page, 8_000); if (!r || !(r.headers.get("content-type") ?? "").includes("html")) return null;
  const html = (await r.text().catch(() => "")).slice(0, 400_000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, "&"), page).toString(); } catch { return null; }
}

/** A save made by Recall itself (a picture kept from Visualize): queued and filed like any other, into the project picked. */
async function queueSave(person: Person, input: { notes: string; files: string[]; project?: string }) {
  const id = `${today()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(person.dir, "files", id); mkdirSync(dir, { recursive: true });
  const files = input.files.map((src) => { const p = join(dir, basename(src)); copyFileSync(src, p); return p; });
  // A project id, or a new project's name (Keep → New project…): made on the spot.
  const cat = await loadCatalog();
  const project = !input.project ? undefined : projects.projectsOf(cat).some((p) => p.id === input.project) ? input.project : (await projects.resolveProject(cat, input.project))?.id;
  const job: Job = { id, person: person.id, notes: input.notes, url: "", keepLocal: false, remind: "never", remindWhen: "", who: person.name, files, created: new Date().toISOString(), project };
  await Bun.write(join(inboxDir(person), `${id}.json`), JSON.stringify(job));
  boards.invalidate(); kick();
  return { id };
}
// Visualize canvases: one per team board (members), and one of your own per person ("me-<id>").
// Creator mode spends Max's Higgsfield/OpenAI money, so it's for the team: people on the Dream board (friends aren't).
const canVisualize = (personId: string, boardId: string) => boards.canSee(personId, boards.defaultId()) && (boardId === `me-${personId}` || boards.canSee(personId, boardId));

async function spokenNote(voice: File, person: Person): Promise<string> {
  const tmp = join(person.dir, "inbox", `voice-${Date.now()}.${(voice.name.split(".").pop() || "m4a").replace(/[^a-z0-9]/gi, "")}`);
  mkdirSync(join(person.dir, "inbox"), { recursive: true }); await Bun.write(tmp, voice);
  try { return await deepgram.transcribeAny(tmp, deepgram.allowed(await isOwner(person))); }
  catch (e) { console.error(`[voice] ${person.id}: ${String(e).slice(0, 200)}`); return ""; } // saved anyway; Clarify asks which project
  finally { try { unlinkSync(tmp); } catch {} }
}

async function save(req: Request, person: Person) {
  const form = await req.formData();
  let notes = String(form.get("notes") ?? "").trim();
  // Links: pasted or dropped (several at once is fine). Images dragged off a web page arrive as image_url.
  const links = [...new Set(form.getAll("url").map((v) => String(v).trim()).filter((v) => /^https?:\/\//i.test(v)))];
  const imageUrls = [...new Set(form.getAll("image_url").map((v) => String(v).trim()).filter((v) => /^https?:\/\//i.test(v)))].slice(0, 30);
  const url = links[0] ?? "";
  const keepLocal = form.get("local") === "on" || form.get("local") === "true";
  const rawWho = (() => { const w = String(form.get("who") ?? ""); try { return decodeURIComponent(w); } catch { return w; } })();
  const who = (rawWho.match(/^(.+?)[’']s\b/)?.[1] ?? rawWho.replace(/\s+(iPhone|iPad|phone)$/i, "")).trim().slice(0, 40) || person.name;
  const remind = String(form.get("remind") ?? "2m");
  const remindWhen = remind === "when" ? String(form.get("remind_when") ?? "").trim() : "";
  const pageTitle = String(form.get("title") ?? "").trim().slice(0, 300); // the browser tab's own title (the extension sends it)
  const uploads = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  // The shortcut's recorded note ("voice"): turned into words now, so the project is known from the first moment.
  const voice = form.get("voice");
  if (!notes && voice instanceof File && voice.size) notes = await spokenNote(voice, person);
  // A project picked on the page or in the shortcut menu: it wins over anything guessed. Unknown ids are ignored.
  const picked = String(form.get("project") ?? "").trim();
  const project = picked && projects.projectsOf(await loadCatalog()).some((p) => p.id === picked) ? picked : undefined;
  // One shortcut run sends each photo on its own; they share a batch so the board shows them as one card.
  const rawBatch = String(form.get("batch") ?? "").trim();
  // A recorded note is sent with every item, so its words can differ slightly per item; the run's time alone groups them.
  const batch = rawBatch ? `${person.id}-${new Bun.CryptoHasher("sha1").update(rawBatch + "|" + (voice instanceof File ? "voice" : notes)).digest("hex").slice(0, 12)}` : undefined;
  if (!notes && !url && !uploads.length && !imageUrls.length) return json({ error: "Attach something or write a note." });
  if (freeBytes() < 5 * 1024 ** 3) return json({ error: `Not saved: the library's disk is almost full. Tell ${OWNER_NAME}.` }, 507);

  // Keep the originals right away.
  const id = `${today()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(person.dir, keepLocal ? "vault" : "files", id);
  const saved: string[] = [];
  for (const [i, u] of uploads.entries()) {
    mkdirSync(dir, { recursive: true });
    const name = u.name.replace(/[/\\]/g, "-").replace(/^\.+$/, "file") || "file";
    const p = join(dir, existsSync(join(dir, name)) ? `${i + 1}-${name}` : name);
    await Bun.write(p, u);
    saved.push(p);
  }
  // A picture for what came from the web: the dragged image itself, or the link's preview image, so the board shows it.
  if (!keepLocal) {
    for (const [i, src] of imageUrls.entries()) { const p = await fetchImage(src, dir, `web-${i + 1}`); if (p) saved.push(p); }
    if (url && !saved.length && !SIGNED_IN.test(url)) { const og = await previewImage(url); const p = og ? await fetchImage(og, dir, "preview") : null; if (p) saved.push(p); }
  }
  const named = !project && !keepLocal ? projects.namedIn(await loadCatalog(), notes) : [];
  const job: Job = { id, person: person.id, notes, url, keepLocal, remind, remindWhen, who, files: saved, created: new Date().toISOString(), project: project ?? (named.length === 1 ? named[0].id : undefined), title: pageTitle || undefined, batch: batch ?? (links.length > 1 ? `${person.id}-${id}` : undefined) };
  await Bun.write(join(inboxDir(person), `${id}.json`), JSON.stringify(job));
  // Every further link becomes its own save with the same words, shown together on the board.
  for (const extra of links.slice(1)) {
    const xid = `${today()}-${Math.random().toString(36).slice(2, 8)}`; const xdir = join(person.dir, keepLocal ? "vault" : "files", xid);
    const og = keepLocal || SIGNED_IN.test(extra) ? null : await previewImage(extra); const pic = og ? await fetchImage(og, xdir, "preview") : null;
    const xjob: Job = { ...job, id: xid, url: extra, files: pic ? [pic] : [] };
    await Bun.write(join(inboxDir(person), `${xid}.json`), JSON.stringify(xjob));
  }
  boards.invalidate();
  if (project && !keepLocal) for (const p of saved) boards.warm(p.replace(ROOT + "/", "")).catch(() => {});
  kick();
  return json({ ok: true, id, title: "✓", queued: true }, 200);
}

/** The librarian's turn: read, file, store. Runs one job at a time in the background. */
async function process(job: Job, person: Person) {
  let body = "", kind = "other", title = "", taken: string | undefined;
  for (const p of job.files) {
    const e = await extractFile(p, job.notes);
    kind = e.kind; if (e.title) title = e.title; if ((e as any).taken && !taken) taken = (e as any).taken;
    if (e.text) body += (body ? "\n\n" : "") + `### ${nameFor(p)}\n\n${e.text}`;
  }
  if (job.url && !SIGNED_IN.test(job.url) && await publicUrl(job.url)) { const e = await extractUrl(job.url).catch(() => null); if (e) { kind = "link"; title = e.title ?? title; body += (body ? "\n\n" : "") + e.text; } }
  // A sign-in wall's title ("Instagram: Log in") or none: the title the person's browser showed.
  if (job.title && (!title || /\b(sign[ -]?in|log ?in)\b/i.test(title))) title = job.title;
  const whole = stripSecrets(body); // the page keeps 200k characters; the pieces read up to 1M
  body = whole.slice(0, 200_000);

  // A voice note with no typed sentence: what was said is the sentence (what it's for, when to bring it back).
  const notes = job.notes || (kind === "audio" ? body.replace(/^### .*\n\n/, "").replace(/^Voice note transcript:\n\n/, "").slice(0, 1500) : "");
  const care = cues.showsDistress(`${notes}\n${body.slice(0, 20000)}`);
  if (care) { job.keepLocal = true; job.privacyDecided = true; job.remind = "never"; job.remindWhen = ""; }
  if (cues.saidPrivate(notes)) { job.keepLocal = true; job.privacyDecided = true; }
  if (cues.saidShareable(notes)) job.privacyDecided = true;
  const catalog = await loadCatalog();
  // Choosing a team project is choosing to share it with the team, so it is never held for the privacy question.
  const chosen = job.project ? projects.projectsOf(catalog).find((x) => x.id === job.project) : undefined;
  if (chosen?.team) job.privacyDecided = true;
  const filing = await fileItem({ notes, text: body.slice(0, 6000), filename: job.files[0] ? nameFor(job.files[0]) : undefined, url: job.url || undefined, kind }, catalog);
  if (filing.sensitive && !job.keepLocal && !job.privacyDecided) {
    // Looks personal and nobody said: wait, unsorted, until the person chooses.
    await Bun.write(join(cues.heldDir(person.dir), `${job.id}.json`), JSON.stringify(job));
    await cues.add(person.dir, { kind: "privacy", item: job.id, title: filing.title, snippet: filing.summary, thumb: job.files.map((f) => f.replace(ROOT + "/", "")).find((f) => VISUAL.test(f)),
      question: "This looks personal. Keep it private, or okay to share?", options: [{ id: "private", label: "Private" }, { id: "shareable", label: "Shareable" }] });
    console.log(`[held] ${person.id}: ${job.id} waits for Private or Shareable`);
    return;
  }
  const shelf = catalog.shelves.find((s) => s.id === filing.shelf)!;
  const finalTitle = job.title && SIGNED_IN.test(job.url) ? job.title : title && filing.confidence < 0.6 ? title : filing.title;
  const slug = `${shelf.id}/${today()}-${slugify(finalTitle)}-${job.id.slice(-6)}`; // the job id keeps same-day, same-title saves apart
  const rel = job.files.map((p) => p.replace(ROOT + "/", ""));
  // The note's "when to resurface" wins over the form's default; an explicit form choice wins over both.
  let remindWhen = job.remindWhen;
  let bringBack = remindWhen ? undefined : dueDate(job.remind);
  const saidDate = parseWhen(notes);
  // Only what the person said brings something back; the librarian's guesses made reminders nobody asked for.
  if ((job.remind === "2m" || job.remind === "never") && saidDate && !care) { bringBack = saidDate; remindWhen = ""; }
  const scope = gb.scopeFor(person.source);
  // A project Max names wins. The librarian's guess counts only if the item itself mentions that project
  // (its name or an alias); a small model otherwise drops everything into whichever project it knows.
  const guessed = filing.project ? projects.matchProject(catalog, filing.project) : undefined;
  const said = `${notes}\n${body.slice(0, 6000)}`.toLowerCase();
  const mentioned = !guessed || [guessed.name, ...(guessed.aliases ?? [])].some((n) => n.length >= 3 && said.includes(n.toLowerCase()));
  // What the person said wins, in this order: a known project named anywhere ("for Zero Proof, the back wall"),
  // first-mentioned first; then "this is for X" when X is a known project; then a new project only when they
  // said so outright ("for the Back Wall project", "a project called…"). Free text like "it's for the back wall"
  // never makes a project by itself: with nothing else to go on, Clarify asks.
  const inNotes = projects.namedIn(catalog, notes);
  const free = namedProject(notes);
  const freeKnown = free ? projects.matchProject(catalog, free) : undefined;
  const madeByThem = free && !freeKnown && /\bproject\b/i.test(notes) ? free : undefined;
  const spokenProject = inNotes[0]?.name ?? freeKnown?.name ?? madeByThem;
  const candidate = spokenProject ?? (mentioned ? filing.project : undefined);
  const isNew = !chosen && !!candidate && !projects.matchProject(catalog, candidate) && !projects.projectsOf(catalog).some((x) => x.id === slugify(candidate));
  const project = chosen ?? await projects.resolveProject(catalog, candidate);
  // A copy of something already filed (the same picture or link): say so on the page, and ask once.
  const dup = job.keepLocal ? undefined : dupes.duplicateOf(person.dir, ROOT, job.files, job.url || undefined);

  if (job.keepLocal) {
    vaultFor(person.dir).put({ id: job.id, title: finalTitle, shelf: shelf.id, tags: filing.tags, summary: filing.summary, notes: job.notes, body, files: rel, created: job.created });
  } else {
    const provenance = [job.who ? `Saved by ${job.who}` : null, taken ? `photo taken ${taken}` : null, kind === "audio" ? "voice note" : null].filter(Boolean).join(", ");
    const md = pageMarkdown({ title: finalTitle, type: shelf.type, shelf: shelf.id, tags: filing.tags, summary: filing.summary, notes: job.notes, body: (provenance ? `${provenance}.\n\n` : "") + body, files: rel, url: job.url || undefined, kind, bring_back: bringBack, bring_back_when: remindWhen || undefined, saved_by: job.who || undefined, project: project?.id, batch: job.batch, duplicate_of: dup?.id });
    await gb.putPage(scope, slug, md);
    for (const t of filing.tags) await gb.addTag(scope, slug, t).catch(() => {});
    if (project) await gb.addTag(scope, slug, `project:${project.id}`).catch(() => {});
    await gb.addTag(scope, slug, `shelf:${shelf.id}`).catch(() => {});
    // A long doc, meeting or voice note: its pieces are pulled out after this, a part at a time.
    if (!care && kind !== "image" && kind !== "video") await pieces.queue(person, { id: job.id, slug, title: finalTitle, notes, project: project?.id, who: job.who || undefined, body: whole.slice(0, 1_000_000) });
  }
  const itemId = job.keepLocal ? `vault:${job.id}` : slug;
  if ((bringBack || remindWhen) && !care) await addReminder(person.dir, { id: itemId, title: finalTitle, summary: filing.summary, local: job.keepLocal, saved: today(), due: bringBack, when: remindWhen || undefined });
  if (filing.proposed_shelf && filing.confidence < 0.5) await noteProposal(catalog, filing.proposed_shelf, itemId, job.notes.slice(0, 120));
  const thumb = rel.find((f) => VISUAL.test(f));
  // An action: the librarian says so, or the words do ("I need to email…", "follow up with…", "call…").
  const actionWords = /\b(need to|have to|got to|must|should (?:email|call|text|send|ask|book|buy|follow)|remind me to|follow up|to-?do|action item|email|call|text|send|book|schedule)\b/i.test(notes);
  const saidWhen = saidDate || /\b(remind me|bring (this|it) back|come back|when we)\b/i.test(notes); // only what the person said counts, not the librarian's guess
  if ((filing.action || actionWords) && !saidWhen && !care)
    await cues.add(person.dir, { kind: "when", item: itemId, title: finalTitle, snippet: filing.summary, thumb, question: "This sounds like something to do. When should it come back?",
      options: [{ id: "tomorrow", label: "Tomorrow" }, { id: "week", label: "Next week" }, { id: "month", label: "In a month" }, { id: "never", label: "No reminder" }] });
  if (project && isNew && !spokenProject && !job.keepLocal && !care) {
    const others = projects.projectsFor(person.dir, catalog).filter((x) => x.id !== project.id).slice(0, 3);
    await cues.add(person.dir, { kind: "project", item: itemId, title: finalTitle, snippet: filing.summary, thumb, question: `The librarian started a new project for this: "${project.name}". Keep it?`,
      options: [{ id: "keep", label: `Keep "${project.name}"` }, ...others.map((o) => ({ id: `to:${o.id}`, label: `Move to ${o.name}` })), { id: "none", label: "No project" }] });
  }
  if (!job.keepLocal && !care && !chosen) {
    const mine = projects.projectsFor(person.dir, catalog);
    const offer = (ids: string[]) => [...new Set(ids)].map((pid) => projects.projectsOf(catalog).find((x) => x.id === pid)).filter(Boolean).slice(0, 4) as projects.Project[];
    if (inNotes.length > 1)
      await cues.add(person.dir, { kind: "project", item: itemId, title: finalTitle, snippet: filing.summary, thumb, question: `You named ${inNotes.map((x) => x.name).join(" and ")}. Which one is this for?`,
        options: [{ id: "keep", label: inNotes[0].name }, ...inNotes.slice(1, 4).map((o) => ({ id: `to:${o.id}`, label: o.name }))] });
    else if (!project && !dup) {
      const choices = offer([...projects.projectsOf(catalog).filter((x) => x.team).map((x) => x.id), ...mine.map((x) => x.id)]);
      await cues.add(person.dir, { kind: "project", item: itemId, title: finalTitle, snippet: job.notes.slice(0, 160) || filing.summary, thumb, question: "Which project is this for?",
        options: [...choices.map((o) => ({ id: `to:${o.id}`, label: o.name })), ...(free && !projects.generic(free) ? [{ id: `new:${free}`, label: `New: ${free.replace(/\b\w/g, (c) => c.toUpperCase())}` }] : []), { id: "none", label: "No project" }] });
    }
  }
  if (dup && !care) await cues.add(person.dir, dupes.duplicateCue(dup, { title: finalTitle, snippet: filing.summary, thumb, kind: job.files.some((f) => /\/web-\d+\./.test(f)) ? "image" : kind }));
  filedAs.set(`${person.id}:${job.id}`, itemId);
  indexCache.delete(person.id); projects.invalidate(person.dir); boards.invalidate();
  if (project) projects.projectView(person.dir, catalog, project.id).catch(() => {}); // topics update the moment it's filed
  console.log(`[filed] ${person.id}: ${itemId} (${shelf.id}${project ? `; project ${project.id}` : ""}; ${filing.tags.join(", ")})`);
}

// Where each save ended up, so a tap on a "being filed" tile can follow it to the filed item.
const filedAs = new Map<string, string>();

let working = false;
async function drain() {
  if (working) return; working = true;
  try {
    const { listPeople } = await import("./identity.ts");
    const people = await listPeople();
    for (const [email, rec] of Object.entries(people.people)) {
      const person = await whoIs("127.0.0.1", email); if (!person) continue;
      const dir = inboxDir(person);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
        const path = join(dir, f);
        let job: Job;
        try { job = JSON.parse(await Bun.file(path).text()); }
        catch { const stuck = join(dir, "..", "inbox-failed"); mkdirSync(stuck, { recursive: true }); renameSync(path, join(stuck, f + ".unreadable")); console.error(`[filing] unreadable job ${f} moved aside`); continue; }
        try { await process(job, person); unlinkSync(path); }
        catch (e) {
          // A service that is down or busy (Ollama restarting, GBrain busy) is not the item's fault: try again later without counting it.
          if (/ECONNREFUSED|fetch failed|Unable to connect|pglite_busy|timed? ?out|aborted/i.test(String(e))) { console.error(`[filing waiting] ${job.id}: ${String(e).slice(0, 160)}`); continue; }
          job.attempts = (job.attempts ?? 0) + 1; console.error(`[filing failed] ${job.id} (attempt ${job.attempts}): ${String(e).slice(0, 200)}`);
          if (job.attempts >= 3) { const stuck = join(dir, "..", "inbox-failed"); mkdirSync(stuck, { recursive: true }); await Bun.write(join(stuck, f), JSON.stringify(job)); unlinkSync(path); }
          else await Bun.write(path, JSON.stringify(job));
        }
      }
    }
  } finally { working = false; }
}
let kickTimer: ReturnType<typeof setTimeout> | null = null;
function kick() { if (kickTimer) clearTimeout(kickTimer); kickTimer = setTimeout(() => drain().catch(() => {}), 300); }
setInterval(() => drain().catch(() => {}), 60_000);
pieces.start({
  busy: () => working,
  people: async () => { const out: Person[] = []; for (const email of Object.keys((await listPeople()).people)) { const p = await whoIs("127.0.0.1", email); if (p && !out.some((o) => o.dir === p.dir)) out.push(p); } return out; },
  onDone: (p) => { indexCache.delete(p.id); projects.invalidate(p.dir); boards.invalidate(); },
});
// Parked jobs get another go every hour, so a fix (or a service coming back) files them without anyone asking.
setInterval(async () => {
  const { listPeople } = await import("./identity.ts");
  for (const email of Object.keys((await listPeople()).people)) {
    const person = await whoIs("127.0.0.1", email).catch(() => null); if (!person) continue;
    const stuck = join(person.dir, "inbox-failed"); if (!existsSync(stuck)) continue;
    for (const f of readdirSync(stuck).filter((n) => n.endsWith(".json"))) {
      try { const job = JSON.parse(readFileSync(join(stuck, f), "utf8")); delete job.attempts; await Bun.write(join(inboxDir(person), f), JSON.stringify(job)); unlinkSync(join(stuck, f)); } catch {}
    }
  }
  kick();
}, 60 * 60_000);
function freeBytes(): number { try { const s = statfsSync(ROOT); return s.bavail * s.bsize; } catch { return Infinity; } }
setTimeout(() => drain().catch(() => {}), 2_000);

// ── Find / browse ───────────────────────────────────────────────────────────
async function browse(person: Person, shelfId?: string) {
  const catalog = await loadCatalog();
  const scope = gb.scopeFor(person.source);
  const vault = vaultFor(person.dir);
  const vc = vault.counts();
  if (!shelfId) {
    const shelves = [];
    for (const s of catalog.shelves) {
      const pages = await gb.listPages(scope, { slug_prefix: `${s.id}/`, limit: 100 }).catch(() => []);
      shelves.push({ ...s, count: pages.length + (vc[s.id] ?? 0) });
    }
    // Items still in the inbox show up right away as "filing…" tiles, so a save is visible the moment it lands.
    const pendingJobs: Job[] = [];
    for (const n of readdirSync(inboxDir(person)).filter((n) => n.endsWith(".json")).sort().reverse()) {
      try { pendingJobs.push(JSON.parse(readFileSync(join(inboxDir(person), n), "utf8"))); } catch {}
    }
    // Saves the librarian couldn't file yet stay visible (they're retried every hour), so nothing silently disappears.
    const stuckDir = join(person.dir, "inbox-failed");
    const stuckJobs: Job[] = existsSync(stuckDir) ? readdirSync(stuckDir).filter((n) => n.endsWith(".json")).sort().reverse().flatMap((n) => { try { return [JSON.parse(readFileSync(join(stuckDir, n), "utf8"))]; } catch { return []; } }) : [];
    const pending = pendingJobs.length;
    const filing = [...pendingJobs.map((j) => ({ j, snippet: "Being filed by the librarian…" })), ...stuckJobs.map((j) => ({ j, snippet: "Saved, but not filed yet. It's tried again every hour." }))]
      .map(({ j, snippet }) => ({ id: `pending:${j.id}`, title: j.notes.slice(0, 80) || (j.url ? j.url : "New item"), snippet, thumb: j.files.map((f) => f.replace(ROOT + "/", "")).find((f) => VISUAL.test(f)), pending: true, local: false }));
    return { shelves, proposed: catalog.proposed.filter((p) => p.items.length >= 3), due: await dueReminders(person.dir, recent.get(person.id) ?? []), pending, filing, person: person.name };
  }
  const pages = await gb.listPages(scope, { slug_prefix: `${shelfId}/`, limit: 100 }).catch(() => []);
  const items = [
    ...pages.map((p: any) => ({ id: p.slug, title: p.title ?? p.slug, summary: p.summary ?? "", local: false, updated: p.updated_at ?? p.updated ?? "" })),
    ...vault.list(shelfId).map((v) => ({ id: `vault:${v.id}`, title: v.title, summary: v.summary, local: true, updated: v.created })),
  ].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { shelf: catalog.shelves.find((s) => s.id === shelfId), items };
}

const FILLER = new Set(["a","an","the","that","this","those","these","my","our","your","his","her","its","of","to","for","in","on","at","about","with","from","and","or","is","was","it","i","we","you","me","us","what","which","where","when","why","how","had","have","has","did","do","thing","things","stuff","something","note","notes","voice","memo","photo","photos","picture","pic","pics","image","screenshot","video","link","call","chat","conversation","recording","saved","save","find","show","get","pull","up","again","one","ones","took","sent","shared","around","like","kind","sort"]);

async function find(person: Person, q: string) {
  const r = recent.get(person.id) ?? []; r.push(q); if (r.length > 20) r.shift(); recent.set(person.id, r);
  const scope = gb.scopeFor(person.source);
  const words = q.toLowerCase().replace(/[’']s\b/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w));
  const stripped = words.join(" ") || q;
  const [sem, kw, tagHits] = await Promise.all([
    gb.search(scope, q, 12).catch(() => []),
    gb.keyword(scope, stripped, 8).catch(() => []),
    Promise.all(words.slice(0, 6).map((w) => gb.listPages(scope, { tag: w, limit: 10 }).catch(() => []))),
  ]);
  const tagCount = new Map<string, { n: number; rare: number; page: any }>();
  tagHits.forEach((rows) => { const rare = (rows as any[]).length <= 3 ? 1 : 0; for (const p of rows as any[]) { const e = tagCount.get(p.slug) ?? { n: 0, rare: 0, page: p }; e.n++; e.rare += rare; tagCount.set(p.slug, e); } });
  const byTag = [...tagCount.entries()].sort((a, b) => (b[1].rare * 2 + b[1].n) - (a[1].rare * 2 + a[1].n)).map(([slug, e]) => ({ slug, title: e.page.title ?? slug, type: e.page.type, chunk_text: e.page.summary ?? "", score: e.rare * 2 + e.n } as gb.Hit));
  const seen = new Set<string>(); const lib: gb.Hit[] = [];
  for (const h of [...byTag.filter((h) => (h.score ?? 0) >= 2), ...sem, ...byTag, ...kw]) if (!seen.has(h.slug)) { seen.add(h.slug); lib.push(h); }
  const local = vaultFor(person.dir).search(stripped, 6);
  const v = (x: any) => ({ id: `vault:${x.id}`, title: x.title, snippet: x.summary || x.notes.slice(0, 200), local: true, score: 1, thumb: x.files.find((f: string) => VISUAL.test(f)) });
  const top = lib.slice(0, 10);
  const peeks = await Promise.all(top.map((h) => peek(person, h.slug)));
  return { results: [
    ...local.strict.map(v),
    ...top.map((h, i) => ({ id: h.slug, title: h.title ?? h.slug, snippet: peeks[i].summary || (h.chunk_text ?? "").replace(/\[truncated \d+ chars[^\]]*\]/g, "").replace(/^[#>*\s]+/, "").replace(/\s+/g, " ").slice(0, 200), local: false, score: h.score ?? 0, thumb: peeks[i].thumb, saved: peeks[i].saved, by: peeks[i].by })),
    ...lib.slice(10).map((h) => ({ id: h.slug, title: h.title ?? h.slug, snippet: (h.chunk_text ?? "").replace(/\s+/g, " ").slice(0, 200), local: false, score: h.score ?? 0 })),
    ...local.loose.map(v),
  ] };
}

// GBrain rewrites frontmatter as YAML (lists on their own lines, long paths folded); parse it properly.
function fmList(fm: string, key: string): string[] {
  let v: unknown; try { v = (Bun.YAML.parse(fm) as any)?.[key]; } catch { return []; }
  return Array.isArray(v) ? v.map(String) : [];
}

/** First attached image (for thumbnails) and a few facts, from a page's frontmatter. */
async function peek(person: Person, slug: string): Promise<{ thumb?: string; summary?: string; saved?: string; by?: string }> {
  const p = await gb.getPage(gb.scopeFor(person.source), slug).catch(() => null); if (!p) return {};
  const content: string = p.content ?? p.markdown ?? "";
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const files = fmList(fm, "files");
  const img = files.find((f) => VISUAL.test(f));
  const sum = content.replace(/^---[\s\S]*?\n---\n?/, "").match(/^> (.+)$/m)?.[1];
  return { thumb: img, summary: sum, saved: fm.match(/^saved: *'?([\d-]+)/m)?.[1], by: fm.match(/^saved_by: *"?([^"\n]+)/m)?.[1] };
}

/** A light index of everything in the person's library for instant, as-you-type matching on the page. */
const indexCache = new Map<string, { at: number; rows: any[] }>();
// Delete with undo, duplicates and the recent-saves feed (trash.ts, dupes.ts, recent.ts) clear these caches.
const findDeps = { root: ROOT, loadCatalog, invalidate: (p: { id: string }) => { indexCache.delete(p.id); boards.invalidate(); } };
async function indexFor(person: Person) {
  const c = indexCache.get(person.id); if (c && Date.now() - c.at < 60_000) return c.rows;
  const scope = gb.scopeFor(person.source);
  const pages = (await gb.listPages(scope, { limit: 100, sort: "created_desc" }).catch(() => [])) as any[];
  const own = pages.filter((p) => !/^(gdocs|docs|notes|tests)\//.test(String(p.slug)));
  const peeks = await Promise.all(own.slice(0, 60).map((p) => peek(person, p.slug)));
  const rows = [
    ...own.slice(0, 60).map((p, i) => ({ id: p.slug, title: p.title ?? p.slug, snippet: peeks[i].summary ?? "", thumb: peeks[i].thumb, saved: peeks[i].saved, by: peeks[i].by, local: false })),
    ...own.slice(60).map((p) => ({ id: p.slug, title: p.title ?? p.slug, snippet: "", local: false })),
    ...pages.filter((p) => /^(gdocs|docs)\//.test(String(p.slug))).map((p) => ({ id: p.slug, title: p.title ?? p.slug, snippet: "", local: false })),
    ...vaultFor(person.dir).list(undefined, 100).map((v) => ({ id: `vault:${v.id}`, title: v.title, snippet: v.summary || v.notes.slice(0, 120), local: true, thumb: v.files.find((f) => VISUAL.test(f)) })),
  ];
  indexCache.set(person.id, { at: Date.now(), rows });
  return rows;
}

async function item(person: Person, id: string): Promise<any> {
  if (id.startsWith("pending:")) {
    // A save still in the inbox: show what we already have (photo, note) until the librarian files it.
    const jobId = id.slice(8);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]{1,8}$/.test(jobId)) return null;
    const done = filedAs.get(`${person.id}:${jobId}`) ?? (vaultFor(person.dir).get(jobId) ? `vault:${jobId}` : undefined);
    if (done) return item(person, done);
    for (const [folder, failed] of [["inbox", false], ["inbox-failed", true]] as const) {
      const path = join(person.dir, folder, `${jobId}.json`);
      if (!existsSync(path)) continue;
      const job: Job = JSON.parse(readFileSync(path, "utf8"));
      return { id, pending: !failed, failed, title: job.notes.slice(0, 80) || job.url || "New item", shelf: "", tags: [], local: job.keepLocal, state: "idea",
        summary: failed ? `The librarian couldn't file this one. It's kept safe; ask ${OWNER_NAME} to look at it.` : "Being filed by the librarian…",
        markdown: job.notes ? `## Why I saved this\n\n${job.notes}` : "", files: job.files.map((f) => f.replace(ROOT + "/", "")), url: job.url || undefined };
    }
    return null;
  }
  if (id.startsWith("vault:")) {
    const v = vaultFor(person.dir).get(id.slice(6)); if (!v) return null;
    return { id, title: v.title, shelf: v.shelf, tags: v.tags, summary: v.summary, local: true, state: v.state ?? "idea", markdown: [v.notes ? `## Why I saved this\n\n${v.notes}` : "", v.body].filter(Boolean).join("\n\n"), files: v.files };
  }
  const p = await gb.getPage(gb.scopeFor(person.source), id).catch(() => null); if (!p) return null;
  const content: string = p.content ?? p.markdown ?? "";
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const get = (k: string) => fm.match(new RegExp(`^${k}: *(.*)$`, "m"))?.[1]?.replace(/^"|"$/g, "") ?? "";
  const files = fmList(fm, "files");
  const tags = fmList(fm, "tags");
  // A piece of a long item: say which item, and the passage, so the page can open the whole at that spot.
  const from = pieces.origin(fm);
  const fromTitle = from ? await gb.getPage(gb.scopeFor(person.source), from.of).then((s: any) => (s?.content ?? "").match(/^title: *(.*)$/m)?.[1]?.replace(/^"|"$/g, "") || s?.title).catch(() => undefined) : undefined;
  return { id, title: get("title") || p.title || id, shelf: get("shelf") || id.split("/")[0], tags, summary: "", local: false, state: get("state") || "idea",
    from: from && fromTitle ? { id: from.of, title: fromTitle, quote: content.match(/## The passage\n\n([\s\S]*?)\n\n## From/)?.[1]?.trim() } : undefined,
    bring_back: describeReminder({ due: get("bring_back") || undefined, when: get("bring_back_when") || undefined }),
    markdown: content.replace(/^---[\s\S]*?\n---\n?/, ""), files, url: get("url"), project: get("project") || undefined };
}

async function setState(person: Person, id: string, state: string) {
  if (!["idea", "doing", "done", "parked"].includes(state)) return json({ error: "bad state" });
  if (id.startsWith("vault:")) vaultFor(person.dir).setState(id.slice(6), state);
  else {
    const scope = gb.scopeFor(person.source);
    const p = await gb.getPage(scope, id); const content: string = p.content ?? p.markdown ?? "";
    const md = /^---[\s\S]*?state: /.test(content) ? content.replace(/^(---[\s\S]*?)state: [^\n]*/, `$1state: ${state}`) : content.replace(/^---\n/, `---\nstate: ${state}\n`);
    await gb.putPage(scope, id, md);
  }
  await setReminderState(person.dir, id, state);
  return json({ ok: true }, 200);
}

async function move(person: Person, id: string, to: string) {
  const catalog = await loadCatalog();
  const shelf = catalog.shelves.find((s) => s.id === to);
  if (!shelf) return json({ error: "no such shelf" });
  if (id.startsWith("vault:")) {
    const vault = vaultFor(person.dir); const v = vault.get(id.slice(6)); if (!v) return json({ error: "not found" }, 404);
    vault.move(v.id, to);
    await updateCatalog((c) => { c.corrections.push({ slug: id, from: v.shelf, to, at: new Date().toISOString() }); });
    return json({ ok: true, id }, 200);
  }
  const scope = gb.scopeFor(person.source);
  const p = await gb.getPage(scope, id); const content: string = p.content ?? p.markdown ?? "";
  const from = id.split("/")[0];
  const newSlug = `${to}/${id.split("/").slice(1).join("/")}`;
  const md = content.replace(/^(---[\s\S]*?)shelf: [^\n]*/, `$1shelf: ${to}`).replace(/^(---[\s\S]*?)type: [^\n]*/, `$1type: ${shelf.type}`);
  await gb.putPage(scope, newSlug, md);
  await gb.deletePage(scope, id).catch(() => {});
  await gb.addTag(scope, newSlug, `shelf:${to}`).catch(() => {});
  await updateCatalog((c) => { c.corrections.push({ slug: newSlug, from, to, at: new Date().toISOString() }); });
  await renameReminder(person.dir, id, newSlug);
  return json({ ok: true, id: newSlug }, 200);
}

/** One click on a cue card. */
async function resolveCue(person: Person, id: string, option: string) {
  const c = await cues.take(person.dir, id); if (!c) return json({ error: "That question was already answered." }, 404);
  if (c.kind === "privacy") {
    const path = join(cues.heldDir(person.dir), `${c.item}.json`);
    const job: Job = JSON.parse(await Bun.file(path).text());
    job.keepLocal = option === "private"; job.privacyDecided = true;
    await Bun.write(path, JSON.stringify(job)); cues.release(person.dir, c.item, inboxDir(person)); kick();
  } else if (c.kind === "when") {
    if (option === "never") await removeReminder(person.dir, c.item);
    else { const d = new Date(); d.setDate(d.getDate() + (option === "tomorrow" ? 1 : option === "week" ? 7 : 30));
      const due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      await addReminder(person.dir, { id: c.item, title: c.title, summary: c.snippet, local: c.item.startsWith("vault:"), saved: today(), due }); }
  } else if (c.kind === "duplicate") {
    if (option === "one") { const g = dupes.groupOf(person.dir, ROOT, c.item); if (g?.extras.length) { const r = await trash.deleteItems(person, g.extras, findDeps); return json({ ok: true, undo: r.undo, deleted: r.deleted }, 200); } }
  } else if (c.kind === "project" && option.startsWith("new:")) {
    const made = await projects.resolveProject(await loadCatalog(), option.slice(4)); await setItemProject(person, c.item, made?.id ?? null);
  } else if (c.kind === "project" && option !== "keep") {
    await setItemProject(person, c.item, option === "none" ? null : option.replace(/^to:/, ""));
  }
  return json({ ok: true }, 200);
}

/** Put a filed item in another project (or none): rewrite its page's project line and project tag. */
async function setItemProject(person: Person, slug: string, projectId: string | null) {
  const scope = gb.scopeFor(person.source);
  const p = await gb.getPage(scope, slug); const content: string = p.content ?? p.markdown ?? "";
  const old = content.match(/^---[\s\S]*?^project: *([^\n]*)$/m)?.[1]?.trim();
  let md = content.replace(/^(---[\s\S]*?)^project: *[^\n]*\n/m, "$1").replace(/^(---[\s\S]*?)^placed: *[^\n]*\n/m, "$1");
  // "placed": put here by hand. It leaves Recently saved and shows first on its project's panel.
  if (projectId) md = md.replace(/^(---\n[\s\S]*?)\n---/, `$1\nproject: ${projectId}\nplaced: ${new Date().toISOString()}\n---`);
  await gb.putPage(scope, slug, md);
  if (old) await gb.removeTag(scope, slug, `project:${old}`).catch(() => {});
  if (projectId) await gb.addTag(scope, slug, `project:${projectId}`).catch(() => {});
  if (projectId) await cues.forgetKind(person.dir, slug, "project"); // a hand placement answers "which project?"
  projects.invalidate(person.dir); indexCache.delete(person.id); boards.invalidate(); // a shared project is the same project on the team board
}

/** Move items into a project, named or by id ("" takes them out of any project). A new name makes the project. */
async function moveToProject(person: Person, ids: string[], to: string) {
  if (!ids.length) return json({ error: "Nothing to move." });
  const catalog = await loadCatalog();
  const target = !to.trim() ? null : projects.projectsOf(catalog).find((x) => x.id === to) ?? await projects.resolveProject(catalog, to);
  if (to.trim() && !target) return json({ error: "Say which project." });
  const own = new Set(projects.scanPages(person.dir).filter((it) => projects.ITEM_SHELVES.test(it.id)).map((it) => it.id));
  let moved = 0;
  for (const id of ids.map(String)) { if (!own.has(id)) continue; await setItemProject(person, id, target?.id ?? null); moved++; }
  console.log(`[move] ${person.id}: ${moved} to ${target?.id ?? "no project"}`);
  return json({ ok: true, moved, project: target ? { id: target.id, name: target.name } : null }, 200);
}

/** "Move all the Buddha artwork to Frequency Wellness": the project it names and the items it means, to confirm. */
const MOVE_FILLER = new Set(["move", "put", "file", "send", "all", "of", "the", "my", "those", "these", "that", "this", "every", "stuff", "things", "items", "item", "saves", "everything", "about", "with", "and", "a", "an"]);
async function movePreview(person: Person, text: string) {
  const m = text.trim().match(/^(.*\S)\s+(?:to|into|in|under|onto)\s+(?:the\s+)?(.+?)[.!]?$/i);
  if (!m) return json({ error: "Say what to move and where, like: the Buddha artwork to Frequency Wellness." });
  const catalog = await loadCatalog();
  const dest = projects.matchProject(catalog, m[2]);
  let words = m[1].toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !MOVE_FILLER.has(w));
  // Kind words narrow by kind ("the Buddha artwork" = pictures that mention Buddha); the rest must be in the item.
  const KINDS: [RegExp, string][] = [[/^(pictures?|photos?|images?|art|artwork|artworks|paintings?|drawings?)$/, "image"], [/^notes?$/, "note"], [/^(documents?|docs?|pdfs?|files?)$/, "document"], [/^links?$/, "link"], [/^videos?$/, "video"], [/^(voice|memos?|recordings?|meetings?)$/, "voice"]];
  const kind = KINDS.find(([re]) => words.some((w) => re.test(w)))?.[1];
  words = words.filter((w) => !KINDS.some(([re]) => re.test(w)));
  if (!words.length && !kind) return json({ error: "Say what to move, like: the Buddha artwork to Frequency Wellness." });
  const items = projects.matchItems(person.dir, words, kind).filter((it) => !dest || it.project !== dest.id).slice(0, 60);
  return json({ project: dest ? { id: dest.id, name: dest.name } : { id: "", name: m[2].replace(/\b\w/g, (c) => c.toUpperCase()), isNew: true }, what: words.join(" "),
    items: items.map((it) => ({ id: it.id, title: it.title, kind: it.kind, thumb: it.thumb, project: it.project })) }, 200);
}

async function decideProposal(person: Person, name: string, action: "approve" | "dismiss", description?: string) {
  const id = slugify(name);
  const prop = await updateCatalog((catalog) => {
    const idx = catalog.proposed.findIndex((p) => p.name === name); if (idx < 0) return undefined;
    const [prop] = catalog.proposed.splice(idx, 1);
    if (action === "approve" && !catalog.shelves.some((s) => s.id === id)) catalog.shelves.push({ id, name: name.replace(/\b\w/g, (c) => c.toUpperCase()), type: "note", description: description || prop.reason });
    return prop;
  });
  if (!prop) return json({ error: "no such proposal" });
  if (action === "approve") { for (const it of prop.items) await move(person, it, id).catch(() => {}); return json({ ok: true, shelf: id }, 200); }
  return json({ ok: true }, 200);
}

/** Speak-to-type: audio from the page → text, by Deepgram when it's on for this person, else on this Mac. */
async function transcribeNote(req: Request, person: Person) {
  const form = await req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size) return json({ error: "No audio received." });
  const tmp = join(person.dir, "inbox", `voice-${Date.now()}.${(audio.name.split(".").pop() || "m4a").replace(/[^a-z0-9]/gi, "")}`);
  mkdirSync(join(person.dir, "inbox"), { recursive: true });
  await Bun.write(tmp, audio);
  try {
    const text = await deepgram.transcribeAny(tmp, deepgram.allowed(await isOwner(person)));
    return json({ ok: true, text }, 200);
  } catch (e) {
    // Keep the audio so the failure can be reproduced by hand.
    const keep = join(person.dir, "inbox-failed"); mkdirSync(keep, { recursive: true });
    try { await Bun.write(join(keep, tmp.split("/").pop()!), Bun.file(tmp)); } catch {}
    console.error(`[transcribe] ${person.id}: ${String(e).slice(0, 300)} (audio kept in inbox-failed)`);
    return json({ error: "Could not transcribe: " + String(e).slice(0, 160) }, 500);
  }
  finally { try { unlinkSync(tmp); } catch {} }
}

/** The Sunday resurface: what to bring back this week, per person. */
async function digest(person: Person) {
  const scope = gb.scopeFor(person.source);
  const dueNow = await dueReminders(person.dir, recent.get(person.id) ?? []);
  const all = await gb.listPages(scope, { limit: 100, sort: "updated_asc" as any }).catch(() => []);
  const ideas = (all as any[]).filter((p) => !String(p.slug).startsWith("gdocs/") && !String(p.slug).startsWith("docs/") && !String(p.slug).startsWith("notes/"));
  const oldest = ideas.slice(0, 2).map((p) => ({ id: p.slug, title: p.title ?? p.slug, summary: p.summary ?? "", why: "saved a while ago and never opened" }));
  const lastWeek = (await gb.listPages(scope, { limit: 20, sort: "created_desc" }).catch(() => []) as any[]).filter((p) => !String(p.slug).startsWith("gdocs/")).slice(0, 5);
  let related: any[] = [];
  if (lastWeek[0]?.title) related = (await gb.search(scope, lastWeek[0].title, 4).catch(() => [])).filter((h) => !lastWeek.some((p) => p.slug === h.slug)).slice(0, 2).map((h) => ({ id: h.slug, title: h.title ?? h.slug, summary: "", why: `related to "${lastWeek[0].title}", which you saved this week` }));
  return { person: person.name, week: today(), due: dueNow.map((r) => ({ id: r.id, title: r.title, summary: r.summary, why: r.when ? `you asked for it when working on ${r.when}` : `you asked for it back on ${r.due}` })), oldest, related, savedThisWeek: lastWeek.map((p) => ({ id: p.slug, title: p.title ?? p.slug })) };
}

async function wish(req: Request, person: Person) {
  const b = await req.json().catch(() => ({}));
  const text = String(b.text ?? "").trim(); if (!text) return json({ error: "Say what you wish it did." });
  const file = join(ROOT, "library/wishes.json");
  const rows = await Bun.file(file).json().catch(() => []);
  rows.push({ text, who: person.name, at: new Date().toISOString() });
  await Bun.write(file, JSON.stringify(rows, null, 2) + "\n");
  return json({ ok: true, count: rows.length }, 200);
}

const guidePage = (req: Request) => page(req, "guide.html");

/** GET /my-shortcut: this person's own "Share to Recall", with a fresh phone key built in, signed so an iPhone can add it. */
const PUBLIC_URL = TWIN && !Bun.env.RECALL_PUBLIC_URL ? `http://127.0.0.1:${PORTS.door}` : CONFIG_URL;
async function shareShortcut(req: Request, person: Person) {
  const q = new URL(req.url).searchParams, mac = q.get("for") === "mac";
  // /my-shortcut?camera=open|save: the two halves of Recall Camera (see shortcuts/build_camera.py).
  // /my-shortcut?camera=recall: "Recall" for Control Center (opens the Save page).
  const camera = mac ? "" : ["open", "save", "recall"].includes(q.get("camera") ?? "") ? q.get("camera")! : "";
  const name = camera === "open" ? "Recall Camera" : camera === "save" ? "Recall Camera Save" : camera === "recall" ? "Recall" : "Save to Recall";
  const work = join(ROOT, ".board-cache", `shortcut-${person.id}-${Date.now()}`); mkdirSync(work, { recursive: true });
  const raw = join(work, "unsigned.shortcut"), signed = join(work, `${name}.shortcut`);
  try {
    // The phone shortcuts use Apple's dictation, which shows the words as they're said (Max, 3 Nov 2026).
    // build_*.py still take "deepgram" (record, then Recall transcribes) if that's wanted again.
    const voice: string[] = [];
    const args = camera === "open" ? ["build_camera.py", "open", raw] : camera === "recall" ? ["build_camera.py", "recall", raw, `${PUBLIC_URL}/`]
      : camera === "save" ? ["build_camera.py", "save", raw, `${PUBLIC_URL}/k/${await mintKey(person.email)}/api/save`, ...voice]
      : ["build_share.py", `${PUBLIC_URL}/k/${await mintKey(person.email)}/api/save`, raw, mac ? "mac" : "iphone", ...voice];
    const b = Bun.spawn(["python3", join(CODE, "shortcuts", args[0]), ...args.slice(1)], { stdout: "pipe", stderr: "pipe" });
    if ((await b.exited) !== 0) throw new Error(await new Response(b.stderr).text());
    const sg = Bun.spawn(["shortcuts", "sign", "--mode", "anyone", "-i", raw, "-o", signed], { stdout: "pipe", stderr: "pipe" });
    await sg.exited;
    if (!existsSync(signed)) throw new Error("signing failed: " + (await new Response(sg.stderr).text()).split("\n").filter((l) => !/Unrecognized attribute/.test(l)).join(" ").slice(0, 200));
    const bytes = await Bun.file(signed).arrayBuffer();
    console.log(`[shortcut] made ${name} (${mac ? "Mac" : "iPhone"}${voice.length ? ", Deepgram" : ""}) for ${person.id}`);
    return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}.shortcut"`, "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[shortcut] ${person.id}: ${String(e).slice(0, 300)}`);
    return json({ error: "The shortcut couldn't be made just now. Try again in a minute." }, 500);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// ── Access ──────────────────────────────────────────────────────────────────
// This Mac itself and phones on the private network (100.64.0.0/10) get in; the
// person is resolved from the network address. Anything else needs the team key.
const ACCESS = join(ROOT, "library/access.json");
async function teamKey(): Promise<string> {
  try { return (await Bun.file(ACCESS).json()).key; } catch {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
    await Bun.write(ACCESS, JSON.stringify({ key, created: new Date().toISOString() }, null, 2) + "\n");
    return key;
  }
}
function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
  return (server.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
}
function onTailnet(ip: string) { const m = ip.match(/^100\.(\d+)\./); return !!m && +m[1] >= 64 && +m[1] <= 127; }
// Headers that carry identity between this app's own listeners. A browser or phone must never be able to set them.
const IDENTITY_HEADERS = ["x-person", "x-tailscale-login", "x-client-ip", "x-public-login"];
const denied = (msg: string) => new Response(msg, { status: 401, headers: { "content-type": "text/plain" } });

const server = Bun.serve({
  port: PORTS.gate,
  maxRequestBodySize: 1024 ** 3, // videos from the Quick Capture shortcut; the same limit on every listener
  websocket: deepgram.relay as any, // live words on the Save page
  async fetch(req, srv) {
    const u = new URL(req.url);
    const ip = clientIp(req, srv);
    const local = ip === "127.0.0.1" || ip === "::1";
    if (!local && !onTailnet(ip)) {
      const key = await teamKey();
      const presented = u.searchParams.get("k") || req.headers.get("x-key") || (req.headers.get("cookie")?.match(/(?:^|;\s*)clk=([a-z0-9]+)/)?.[1] ?? "");
      if (presented !== key) return denied(`This library needs your link. Ask ${OWNER_NAME} for it.`);
    }
    // Phones that open the plain-http address get sent to the https one, so the
    // microphone works. Only for page loads; the Shortcut's POSTs are left alone.
    const HTTPS_HOST = TAILNET_HOST;
    if (HTTPS_HOST && !TWIN && req.method === "GET" && u.pathname === "/" && !local && !req.headers.get("tailscale-user-login") && u.hostname !== HTTPS_HOST) {
      return Response.redirect(`https://${HTTPS_HOST}/`, 302);
    }
    // The Soul Map (a second service on this Mac, 127.0.0.1:3355) answers everything under /soul.
    if (isSoulPath(u.pathname)) return soulProxy(req, u, ip, local);
    if (u.pathname === deepgram.LISTEN_PATH) {
      const p = await whoIs(local ? "127.0.0.1" : ip, local ? req.headers.get("tailscale-user-login") : null);
      return p ? deepgram.upgrade(req, srv, await isOwner(p)) : denied("Not signed in.");
    }
    const headers = new Headers(req.headers);
    for (const h of IDENTITY_HEADERS) headers.delete(h);
    headers.set("x-client-ip", ip);
    // Behind `tailscale serve` (the https address) the request arrives from this Mac
    // with the person's login attached; pass it through as the identity.
    if (local && req.headers.get("tailscale-user-login")) headers.set("x-tailscale-login", req.headers.get("tailscale-user-login")!);
    else if (local && u.hostname === HTTPS_HOST) return denied("This device isn't signed in to the private network as a person.");
    const inner = new Request(`http://127.0.0.1:${PORTS.inner}${u.pathname}${u.search}`, { method: req.method, headers, body: req.body, duplex: "half" } as any);
    return fetch(inner);
  },
});

// The public door (RECALL_PUBLIC_URL → tunnel → here). Only an invite cookie gets in;
// nothing here is ever treated as this Mac. The Soul Map stays private-network only.
const door = Bun.serve({
  port: PORTS.door, hostname: "127.0.0.1",
  maxRequestBodySize: 1024 ** 3,
  websocket: deepgram.relay as any,
  async fetch(req, srv) {
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/join\/([A-Za-z0-9_-]{20,64})$/);
    if (m && req.method === "GET") return joinPage(m[1], req);
    if (m && req.method === "POST") return joinDoor(m[1]);
    const team = u.pathname.match(/^\/team\/([A-Za-z0-9_-]{16,64})$/);
    if (team && req.method === "GET") return teamEntry(team[1]);
    const friend = u.pathname.match(/^\/invite\/([A-Za-z0-9_-]{16,64})$/);
    if (friend && req.method === "GET") return teamEntry(friend[1], "friend");
    if (u.pathname === "/auth/google" && req.method === "POST") return googleSignIn(req);
    if (u.pathname === "/signin") return signInPage(req);
    { const bd = await boardDoor(req); if (bd) return bd; } // board invite links (/b/<token>)
    if (u.pathname === "/privacy") return privacyPage();
    if (u.pathname === "/guide") return guidePage(req); // public: a teammate reads it before signing in
    if (/^\/static\/(icon-(32|180|192|512)\.png|manifest\.webmanifest|find-landscape\.svg|(?:delta|river)-[0-9]+\.(?:jpg|webp)|ui\/[a-z0-9-]+\.(?:js|css)|onboard\/[a-z0-9-]+\.jpg)$/.test(u.pathname)) return fetch(new Request(`http://127.0.0.1:${PORTS.inner}${u.pathname}`));
    if (isSoulPath(u.pathname)) return new Response("not found", { status: 404 });
    // A person's own shortcut: its key can save, nothing else.
    const k = u.pathname.match(/^\/k\/([A-Za-z0-9_-]{20,64})\/api\/save$/);
    if (k) {
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const owner = await emailForKey(k[1]);
      if (!owner) return Response.json({ error: "This shortcut's key doesn't work any more. Get a fresh copy from Recall." }, { status: 401 });
      const headers = new Headers(req.headers);
      for (const h of IDENTITY_HEADERS) headers.delete(h);
      headers.set("x-client-ip", "127.0.0.1"); headers.set("x-tailscale-login", owner);
      return fetch(new Request(`http://127.0.0.1:${PORTS.inner}/api/save`, { method: "POST", headers, body: req.body, duplex: "half" } as any));
    }
    const email = await sessionEmail(req);
    if (!email) return signInPage(req, "", 401);
    if (u.pathname === deepgram.LISTEN_PATH) return deepgram.upgrade(req, srv, (await listPeople()).owner === email);
    const headers = new Headers(req.headers);
    for (const h of IDENTITY_HEADERS) headers.delete(h);
    headers.set("x-client-ip", "127.0.0.1");
    headers.set("x-tailscale-login", email);
    return fetch(new Request(`http://127.0.0.1:${PORTS.inner}${u.pathname}${u.search}`, { method: req.method, headers, body: req.body, duplex: "half" } as any));
  },
});

/** Resolve the person for an inner request (the gate above set x-client-ip). */
async function who(req: Request): Promise<Person | Response> {
  const ip = req.headers.get("x-client-ip") || "127.0.0.1";
  const isLocal = ip === "127.0.0.1" || ip === "::1";
  const override = isLocal ? (req.headers.get("x-tailscale-login") || req.headers.get("x-person")) : null; // https proxy identity, or local testing
  const p = await whoIs(isLocal ? "127.0.0.1" : ip, override);
  return p ?? denied(`Your phone is on the network but isn't set up in the library yet. Ask ${OWNER_NAME} to add you.`);
}
const withPerson = (fn: (req: Request, p: Person) => Promise<Response>) => async (req: Request) => { const p = await who(req); return p instanceof Response ? p : fn(req, p); };

// Keys: paste a service key once (owner only); see service-keys.ts.
const isOwner = async (p: Person) => (await listPeople()).owner === p.email;
const settingsPage = async (req: Request, p: Person) => await isOwner(p) ? keysPage(new URL(req.url).searchParams.get("key") ?? "") : new Response(`Only ${OWNER_NAME} can open this page.`, { status: 403 });
const saveKey = async (req: Request, p: Person) => await isOwner(p) ? saveServiceKey(await req.json().catch(() => ({})), p.id) : json({ error: `Only ${OWNER_NAME} can change keys.` }, 403);

// A page, checked against the copy the phone already has: unchanged → "304", nothing re-sent.
// Each script and style address carries its file's version (?v=…): Cloudflare tells browsers to keep /static
// files for hours, so a changed file must get a new address or a phone keeps running the old one with the new page.
function page(req: Request, name: string): Response {
  // This install's address and owner, so the pages read right on anyone's Recall.
  const html = readFileSync(join(import.meta.dir, name), "utf8").replaceAll("{{HOST}}", PUBLIC_HOST).replaceAll("{{OWNER}}", OWNER_NAME)
    .replace("</head>", `<script>window.RECALL_OWNER = ${JSON.stringify(OWNER_NAME)};</script></head>`).replace(/(["'])\/static\/ui\/([a-z0-9-]+\.(?:js|css))\1/g, (_m, q, f) => {
    try { return `${q}/static/ui/${f}?v=${Math.floor(statSync(join(import.meta.dir, "static/ui", f)).mtimeMs).toString(36)}${q}`; } catch { return `${q}/static/ui/${f}${q}`; }
  });
  const tag = `"${Bun.hash(html).toString(36)}"`;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", etag: tag };
  return req.headers.get("if-none-match") === tag ? new Response(null, { status: 304, headers }) : new Response(html, { headers });
}

const routed = Bun.serve({
  port: PORTS.inner, hostname: "127.0.0.1",
  maxRequestBodySize: 1024 ** 3,
  routes: {
    // Served as a plain file with no-cache so the home-screen app on the phone always picks up the latest page.
    "/": (req: Request) => page(req, "index.html"),
    "/api/save": { POST: withPerson(save) },
    "/settings": withPerson(settingsPage),
    "/api/settings/key": { POST: withPerson(saveKey) },
    "/api/browse": withPerson(async (req, p) => json(await browse(p, new URL(req.url).searchParams.get("shelf") ?? undefined), 200)),
    "/api/search": withPerson(async (req, p) => json(await find(p, new URL(req.url).searchParams.get("q") ?? ""), 200)),
    "/api/item": withPerson(async (req, p) => { const r = await item(p, new URL(req.url).searchParams.get("id") ?? ""); return r ? json(r, 200) : json({ error: "not found" }, 404); }),
    "/api/move": { POST: withPerson(async (req, p) => { const b = await req.json(); return move(p, b.id, b.to); }) },
    "/api/item/project": { POST: withPerson(async (req, p) => { const b = await req.json(); return moveToProject(p, Array.isArray(b.ids) ? b.ids : [], String(b.project ?? "")); }) },
    "/api/move/preview": { POST: withPerson(async (req, p) => { const b = await req.json(); return movePreview(p, String(b.text ?? "")); }) },
    ...visualizeRoutes(withPerson, { queueSave, canSee: canVisualize, chat }),
    ...findRoutes(withPerson, findDeps), // /api/delete (with undo), /api/undelete, /api/trash, /api/recent, /api/duplicates
    "/api/state": { POST: withPerson(async (req, p) => { const b = await req.json(); return setState(p, b.id, b.state); }) },
    "/api/wish": { POST: withPerson(wish) },
    "/api/transcribe": { POST: withPerson(transcribeNote) },
    // Live words on the Save page: where to stream (the relay below), or {off} to use the browser's own speech.
    "/api/listen": { POST: withPerson(async (_req, p) => json(deepgram.allowed(await isOwner(p)) ? { path: deepgram.LISTEN_PATH } : { off: true }, 200)) },
    "/api/log": { POST: withPerson(async (req, p) => { const b = await req.json().catch(() => ({})); console.log(`[voice ${p.id}] ${JSON.stringify(b)}`); return json({ ok: true }, 200); }) },
    "/api/digest": withPerson(async (_req, p) => json(await digest(p), 200)),
    "/api/proposal": { POST: withPerson(async (req, p) => { const b = await req.json(); return decideProposal(p, b.name, b.action, b.description); }) },
    "/api/shelves": async () => json(await loadCatalog(), 200),
    "/api/index": withPerson(async (_req, p) => json({ items: await indexFor(p) }, 200)),
    "/api/projects": withPerson(async (_req, p) => json({ projects: projects.projectsFor(p.dir, await loadCatalog()).map((r) => ({ ...r, shared: boards.isShared(r.id, p.id) })) }, 200)),
    "/api/project": withPerson(async (req, p) => { const id = new URL(req.url).searchParams.get("id") ?? ""; const catalog = await loadCatalog(); return json({ ...(await projects.projectView(p.dir, catalog, id)), shared: boards.isShared(id, p.id, catalog), alwaysShared: boards.alwaysShared(catalog, id) }, 200); }),
    "/api/topic/rename": { POST: withPerson(async (req, p) => { const b = await req.json(); return json({ ok: await topics.rename(p.dir, String(b.project), String(b.topic), String(b.name ?? "")) }, 200); }) },
    "/api/cues": withPerson(async (_req, p) => json({ cues: await cues.list(p.dir) }, 200)),
    "/api/cues/resolve": { POST: withPerson(async (req, p) => { const b = await req.json(); return resolveCue(p, String(b.id), String(b.option)); }) },
    "/api/topic/move": { POST: withPerson(async (req, p) => { const b = await req.json(); return json({ ok: await topics.move(p.dir, String(b.project), String(b.item), String(b.topic)) }, 200); }) },
    "/guide": (req: Request) => guidePage(req),
    // Shown until finished on this kind of device; finishing (Done) is what marks it, not opening it.
    "/api/welcomed": { POST: withPerson(async (req, p) => { await setWelcomed(p.email, true, deviceKind(req.headers.get("user-agent") ?? "")); return json({ ok: true }, 200); }) },
    // Recall for Chrome, added by hand until the Chrome Web Store has it: the steps, and the extension itself.
    "/extension": withPerson(async (req) => page(req, "extension.html")),
    "/extension/recall-chrome.zip": withPerson(async () => new Response(Bun.file(join(CODE, "dist/recall-chrome-0.3.0.zip")), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="recall-chrome.zip"', "cache-control": "no-cache" } })),
    "/welcome": withPerson(async (req) => page(req, "welcome.html")),
    "/board": (req: Request) => page(req, "board.html"),
    ...boardRoutes(withPerson), // team boards: members only (boards-routes.ts)
    "/my-shortcut": withPerson(shareShortcut),
    "/api/me": withPerson(async (_req, p) => json({ id: p.id, name: p.name, source: p.source }, 200)),
    "/api/health": async () => json({ ok: true, library: await gb.callTool("whoami").catch((e) => ({ error: String(e) })) }, 200),
  },
  async fetch(req) {
    const u = new URL(req.url);
    // Small JPEG thumbnails (any format in, HEIC included), made once and cached next to the library.
    // The Quick Capture shortcut (photo or video, then voice). Opening this on an iPhone offers to add it.
    if (u.pathname === "/quick-capture.shortcut" && existsSync(join(CODE, "shortcuts/quick-capture.shortcut"))) return new Response(Bun.file(join(CODE, "shortcuts/quick-capture.shortcut")), { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="Quick Capture.shortcut"' } });
    // The app icon and manifest (for "Add to Dock" / home screen). Public, no personal data.
    // The river painting stays out of the public repo (its artist isn't known): without it, the delta photograph shows.
    const staticFile = (p: string) => { const f = join(import.meta.dir, p); return existsSync(f) ? f : join(import.meta.dir, p.replace(/\/river-/, "/delta-")); };
    if (/^\/static\/(icon-(32|180|192|512)\.png|manifest\.webmanifest|find-landscape\.svg|(?:delta|river)-[0-9]+\.(?:jpg|webp)|ui\/[a-z0-9-]+\.(?:js|css)|onboard\/[a-z0-9-]+\.jpg)$/.test(u.pathname)) return new Response(Bun.file(staticFile(u.pathname)), { headers: { "cache-control": u.pathname.startsWith("/static/ui/") ? "no-cache" : "public, max-age=86400", ...(u.pathname.endsWith(".webmanifest") ? { "content-type": "application/manifest+json" } : {}) } });
    if (u.pathname.startsWith("/thumb/")) {
      const p = await who(req); if (p instanceof Response) return p;
      const rel = decodeURIComponent(u.pathname.slice(7));
      if (rel.includes("..")) return new Response("no", { status: 400 });
      const abs = join(ROOT, rel);
      if (!(abs.startsWith(join(p.dir, "files") + "/") || abs.startsWith(join(p.dir, "vault") + "/")) || !existsSync(abs)) return new Response("not found", { status: 404 });
      const cacheDir = join(p.dir, ".thumbs"); mkdirSync(cacheDir, { recursive: true });
      const out = join(cacheDir, rel.replace(/[\/]/g, "_").replace(/\.[^.]+$/, "") + ".360.jpg"); // 360px: tiles are at most ~180px wide
      if (!existsSync(out)) {
        if (/\.(mp4|mov|m4v|webm)$/i.test(abs)) {
          // A frame one second in (or the first frame of a very short clip).
          for (const at of ["1", "0"]) { if (existsSync(out)) break; await Bun.spawn(["ffmpeg", "-v", "error", "-y", "-ss", at, "-i", abs, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", out]).exited; }
          if (!existsSync(out)) return new Response("no frame", { status: 404 });
        } else {
          const r = Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "360", abs, "--out", out], { stdout: "pipe", stderr: "pipe" });
          if ((await r.exited) !== 0 || !existsSync(out)) return new Response(Bun.file(abs));
        }
      }
      return new Response(Bun.file(out), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } }); // a saved file never changes
    }
    if (u.pathname.startsWith("/files/")) {
      const p = await who(req); if (p instanceof Response) return p;
      const rel = decodeURIComponent(u.pathname.slice(7));
      if (rel.includes("..")) return new Response("no", { status: 400 });
      const abs = join(ROOT, rel);
      // A person may only read files under their own library.
      if (!(abs.startsWith(join(p.dir, "files") + "/") || abs.startsWith(join(p.dir, "vault") + "/")) || !existsSync(abs)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(abs), { headers: { "cache-control": "private, max-age=31536000, immutable" } }); // a saved file never changes
    }
    return new Response("not found", { status: 404 });
  },
  development: { hmr: false, console: false },
});
console.log(`Recall app: ${server.url} (inner ${routed.url}, public door ${door.url})`);

// Creator mode's Higgsfield sign-in lasts a day and carries a refresh token: a check-in every 30 minutes lets the
// CLI renew it before it runs out (and the log says so if it can't, so Max can run higgsfield auth login).
if (!TWIN && existsSync("/opt/homebrew/bin/higgsfield")) setInterval(async () => {
  const p = Bun.spawn(["/opt/homebrew/bin/higgsfield", "account", "status"], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) console.error(`[higgsfield] sign-in check failed: ${(await new Response(p.stderr).text()).trim().slice(0, 160)}. Max: run higgsfield auth login`);
}, 30 * 60_000);

// Warm up, so the first person to open Recall after a restart doesn't wait: the team board, everyone's Find,
// and the small picture of every saved photo (what the folders and grids show). One at a time, in the background.
setTimeout(async () => {
  const t0 = Date.now(); let pics = 0;
  try {
    await boards.teamPanels(await loadCatalog());
    const ppl = await listPeople();
    for (const email of Object.keys(ppl.people)) { const p = await whoIs("127.0.0.1", email).catch(() => null); if (p) await browse(p).catch(() => {}); }
    const dirs = [join(ROOT, "library/files"), ...(existsSync(join(ROOT, "libraries")) ? readdirSync(join(ROOT, "libraries")).map((d) => join(ROOT, "libraries", d, "files")) : [])];
    for (const d of dirs.filter((x) => existsSync(x))) for (const f of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: d }))) {
      if (!/\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f)) continue;
      await boards.warmSmall(join(d, f).replace(ROOT + "/", "")); pics++;
    }
  } catch (e) { console.error(`[warm] ${String(e).slice(0, 200)}`); }
  console.log(`[warm] ready in ${Date.now() - t0} ms (${pics} pictures)`);
}, 2000);
