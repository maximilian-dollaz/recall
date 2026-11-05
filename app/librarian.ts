// The librarian: a local model that files a saved item onto a shelf, tags it,
// writes a one-line summary, and describes images. It never edits content.

import { join } from "node:path";

import { DATA as ROOT } from "./paths.ts";
import * as store from "./store.ts";
const OLLAMA = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
const MODEL = process.env.LIBRARIAN_MODEL ?? "gemma3:4b";

export type Shelf = { id: string; name: string; type: string; description: string };
export type Catalog = { version: number; shelves: Shelf[]; proposed: Proposal[]; corrections: Correction[]; projects?: { id: string; name: string; aliases?: string[] }[] };
export type Proposal = { name: string; reason: string; items: string[]; created: string };
export type Correction = { slug: string; from: string; to: string; at: string };
export type Filing = { shelf: string; tags: string[]; summary: string; title: string; confidence: number; proposed_shelf?: string; image_description?: string; resurface_days?: number; resurface_when?: string; project?: string; sensitive?: boolean; action?: boolean };

// The catalog (shelves, proposals, corrections, projects) is one file everyone's saves touch.
// A missing or unreadable catalog stops filing with a plain error; it is never replaced by an empty one.
const CATALOG = join(ROOT, "library/categories.json");
const must = (c: Catalog | null): Catalog => { if (!c) throw new Error(`${CATALOG} is missing or empty`); return c; };
const loud = (e: any): never => { console.error(`[catalog] ${CATALOG} left untouched: ${e?.message ?? e}`); throw e; };

export async function loadCatalog(): Promise<Catalog> {
  try { return must(store.read<Catalog | null>(CATALOG, null)); } catch (e) { return loud(e); }
}

/** Change the catalog safely: `fn` gets a fresh copy inside the lock, changes it in place, and may return a
 *  result (e.g. the project it made). Changes made meanwhile by other saves are kept. Keep `fn` quick:
 *  no model calls inside, everyone's catalog changes wait on it. */
export async function updateCatalog<R = void>(fn: (c: Catalog) => R | Promise<R>): Promise<R> {
  let out!: R;
  await store.update<Catalog | null>(CATALOG, null, async (c) => { const fresh = must(c); out = await fn(fresh); return fresh; }).catch(loud);
  return out;
}

/** Write a whole catalog (serialised and atomic). It replaces changes made since `c` was read,
 *  so prefer updateCatalog for anything that reads, changes and saves. */
export async function saveCatalog(c: Catalog) { await store.update<Catalog | null>(CATALOG, null, () => c).catch(loud); }

export async function chat(messages: any[], opts: { json?: boolean; images?: string[] } = {}): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", signal: AbortSignal.timeout(180_000), // a hung model must not stop all filing
    body: JSON.stringify({
      model: MODEL, stream: false, messages,
      format: opts.json ? "json" : undefined,
      options: { temperature: 0, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`librarian model error ${res.status}: ${await res.text()}`);
  return (await res.json()).message?.content ?? "";
}

/** Describe a picture so it becomes searchable text. */
export async function describeImage(base64: string, notes: string): Promise<string> {
  const text = await chat([{
    role: "user",
    images: [base64],
    content: `Describe this image so it can be found again months later from a plain description. The person saving it wrote: "${notes || "(no notes)"}".

Write, in plain text:
1. OBJECTS: the main things in the picture, each named specifically (e.g. "throw pillow", "bar counter", "pendant light", "earplugs"), with material, colour, pattern and style words a person would use to search ("Middle Eastern geometric pattern", "brass and dark walnut", "mid-century", "boho", "industrial").
2. SETTING: where it seems to be (a bar, a lounge, a shop, a dance studio, outdoors) and the mood or style of the space.
3. TEXT: if there is any readable text (a sign, a label, a price tag, a screenshot, a whiteboard), transcribe it faithfully.
Three to six sentences. No preamble.`,
  }]);
  return text.trim();
}

/** Decide where an item goes. Returns the filing; never touches the item. */
export async function file(input: { notes: string; text?: string; filename?: string; url?: string; kind?: string }, catalog: Catalog): Promise<Filing> {
  const shelves = catalog.shelves.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  const recent = catalog.corrections.slice(-12).map((c) => `- moved ${c.slug} from ${c.from} to ${c.to}`).join("\n");
  const body = (input.text ?? "").slice(0, 6000);
  const projects = (catalog.projects ?? []).map((p) => [p.name, ...(p.aliases ?? [])].join(" / ")).join("; ");
  const prompt = `You are the librarian for one person's private library. File the item below.

Known projects (the businesses, physical spaces and initiatives the owner's items are for): ${projects || "(none yet)"}

Shelves (choose exactly one id):
${shelves}

${recent ? `Recent corrections by the owner (learn from them):\n${recent}\n` : ""}
Item notes from the owner, usually three parts: what it's for, why they saved it, when to resurface it (most important signal; "what it's for" decides the shelf, "why" becomes part of the summary, "when" becomes the resurface fields): """${input.notes || "(none)"}"""
${input.filename ? `Filename: ${input.filename}\n` : ""}${input.url ? `URL: ${input.url}\n` : ""}${body ? `${input.kind === "image" || input.kind === "video" ? "What the picture shows (written by the vision model; title and summarize the PICTURE, never this description)" : "Content"}:\n"""${body}"""` : ""}

Rules:
- "writing" is ONLY for things the owner wrote themselves as a piece of writing (an essay, a draft, a journal entry). An essay, article, artwork, sign, video or post by someone else goes to "inspiration" (if saved because it sparked something) or "reference" (if saved to look facts up). A voice note or typed note ABOUT something is not writing; file by what the something is.
- When the item is a photo of a document, sign, poster or artwork, or a link, take the TITLE from the item itself (its headline or name), not from the owner's words; the owner's words may contain typos or be casual.
- The owner's notes say why it was saved; let that decide between inspiration and reference.
- "people" is for notes about someone the owner knows or deals with (what they said, what was promised). A photo of a poster, article or artwork that happens to name its author is NOT a people item; file it as inspiration or reference. An organization as the subject goes to "companies".
- If the owner's note says nothing useful (e.g. "test", "saving this"), file by what the item itself is.
- Tags are topics, not shelf names. ALWAYS include as tags: every person named (first name is fine), every place or address, every named thing (a shop, an event, a product), and the two or three most vivid phrases a person would remember this by. Up to 8 tags.
- PROJECT: if the owner's notes (or the item itself) say which business, physical space, event or initiative this is FOR ("for Elemental", "the Zero Proof bar", "Frequency lounge"), put that name in "project". Use the known project's exact name when it is the same place; otherwise the name as the owner said it. Omit "project" when nothing is named. Never guess a project from a tag or the picture alone.
- For a photo: the title names the main object and its look ("Middle Eastern patterned throw pillow"), tags are the objects, materials, colours, styles and the room or space; the summary says what it is and what the owner wants it for. Never use words like "image", "photo", "analysis", "description" in the title.

Reply with JSON only:
{"shelf": "<shelf id>", "confidence": <0..1>, "tags": ["3-8 short lowercase tags: people, places, named things, vivid phrases, topics"], "title": "<a short specific title, max 8 words>", "summary": "<one line: what this is and why it was saved, max 30 words>", "proposed_shelf": "<only if confidence < 0.5: a one-or-two-word name for a shelf that would fit better, else omit>", "resurface_days": <only if the notes say when to bring it back as a time ("in two weeks", "next month", "before December"): the number of days from now, else omit>, "resurface_when": "<only if the notes say to bring it back when working on something ("when we do the lobby", "for the launch"): that thing in 2-5 words, else omit>", "project": "<the business, space or initiative this is for, if named; else omit>", "sensitive": <true only if it is about the owner's health, mental or emotional state, money trouble, intimate relationships, or someone else's private matters; else false>, "action": <true if the owner says something needs to be done (a task, a follow-up, someone to contact); else false>}`;
  const raw = await chat([{ role: "user", content: prompt }], { json: true });
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  const ids = new Set(catalog.shelves.map((s) => s.id));
  const shelf = ids.has(parsed.shelf) ? parsed.shelf : "reference";
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).toLowerCase().trim().replace(/\s+/g, "-")).filter(Boolean).slice(0, 8) : [];
  return {
    shelf,
    tags,
    title: String(parsed.title || input.filename || input.notes.slice(0, 60) || "Untitled").trim(),
    summary: String(parsed.summary || "").trim(),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    proposed_shelf: parsed.proposed_shelf ? String(parsed.proposed_shelf).toLowerCase().trim() : undefined,
    resurface_days: typeof parsed.resurface_days === "number" && parsed.resurface_days > 0 && parsed.resurface_days < 400 ? Math.round(parsed.resurface_days) : undefined,
    resurface_when: parsed.resurface_when ? String(parsed.resurface_when).trim().slice(0, 60) : undefined,
    sensitive: parsed.sensitive === true,
    action: parsed.action === true,
    project: parsed.project && typeof parsed.project === "string" && !/^(none|n\/a|null|unknown)$/i.test(parsed.project.trim()) ? parsed.project.trim().slice(0, 60) : undefined,
  };
}

/** Record a low-confidence filing as evidence for a new shelf. Three items make a proposal visible. */
export async function noteProposal(catalog: Catalog, name: string, slug: string, reason: string) {
  // On a fresh read: the caller's copy is from before the model call, and may be missing projects made since.
  const proposed = await updateCatalog((c) => {
    const existing = c.proposed.find((p) => p.name === name);
    if (existing) { if (!existing.items.includes(slug)) existing.items.push(slug); }
    else c.proposed.push({ name, reason, items: [slug], created: new Date().toISOString() });
    return c.proposed;
  });
  catalog.proposed = proposed; // keep the caller's copy in step, as before
}
