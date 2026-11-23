// Share a project (or part of one) with another person or another person's agent.
// A share is a snapshot of the chosen items behind a long unguessable link, read-only, good for 30 days, and the
// person can stop it at any time. People get a page (/s/<token>); agents get the same thing as markdown
// (/s/<token>.md). Nothing here can read anything that was not in the snapshot.
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { DATA, PORTS, TWIN } from "./paths.ts";
import { PUBLIC_URL } from "./config.ts";
import { scanPages, projectsOf, type ProjectItem } from "./projects.ts";
import { loadCatalog } from "./librarian.ts";
import { jpegArgs } from "./img.ts";
import type { Person } from "./identity.ts";
import * as mailer from "./mailer.ts";

const DIR = join(DATA, "shares");
const DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const IMG = /\.(jpe?g|png|webp|gif|heic)$/i;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fileOf = (token: string) => join(DIR, hash(token) + ".json");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Snap = {
  owner: string; dir: string; project: string; name: string; created: string; expires: string; key: string; token?: string;
  items: { title: string; kind: string; summary: string; notes?: string; url?: string; saved: string; by?: string; files: string[] }[];
};

/** Where a link opens: this install's public address (on the twin, the twin's own door). */
export const base = () => (TWIN ? `http://localhost:${PORTS.door}` : PUBLIC_URL);

const read = (token: string): Snap | null => {
  try {
    const s = JSON.parse(readFileSync(fileOf(token), "utf8")) as Snap;
    if (Date.parse(s.expires) < Date.now()) { try { unlinkSync(fileOf(token)); } catch {} return null; }
    return s;
  } catch { return null; }
};

const links = (token: string) => ({ page: `${base()}/s/${token}`, agent: `${base()}/s/${token}.md`, token, days: DAYS });

/** Make (or reuse) a link for these items of one of this person's projects. */
export async function create(p: Person, project: string, ids: string[] | null) {
  const catalog = await loadCatalog();
  const proj = projectsOf(catalog).find((x) => x.id === project);
  if (!proj) return { error: "That project isn't available." };
  let items = scanPages(p.dir).filter((it) => it.project === project);
  if (ids?.length) { const want = new Set(ids); items = items.filter((it) => want.has(it.id)); }
  if (!items.length) return { error: "Nothing here to share yet." };
  const key = hash(`${p.id}|${project}|${items.map((i) => i.id).sort().join(",")}`);
  mkdirSync(DIR, { recursive: true });
  // The same items shared again reuse the live link, so opening Share twice makes one link, not two.
  for (const f of readdirSync(DIR)) {
    try {
      const s = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Snap;
      if (s.key === key && s.token && Date.parse(s.expires) > Date.now()) return links(s.token);
    } catch {}
  }
  const token = randomBytes(24).toString("base64url");
  const snap: Snap = {
    owner: p.id, dir: p.dir, project, name: proj.name, key, token,
    created: new Date().toISOString(), expires: new Date(Date.now() + DAYS * 864e5).toISOString(),
    items: items.map((it: ProjectItem) => ({ title: it.title, kind: it.kind, summary: it.summary, notes: it.notes, url: it.url, saved: it.saved, by: it.by, files: it.files })),
  };
  writeFileSync(fileOf(token), JSON.stringify(snap), { mode: 0o600 });
  return links(token);
}

/** Stop a link. Only the person who made it can. */
export function stop(p: Person, token: string) {
  if (!TOKEN.test(token)) return { ok: false };
  const s = read(token);
  if (!s || s.owner !== p.id) return { ok: false };
  try { unlinkSync(fileOf(token)); } catch {}
  return { ok: true };
}

const label: Record<string, string> = { image: "Photo", voice: "Voice note", video: "Video", link: "Link", document: "Document", note: "Note" };

function markdown(s: Snap, token: string): string {
  const out = [`# ${s.name}`, "", `Shared from Recall, read-only. ${s.items.length} saved item${s.items.length === 1 ? "" : "s"}. Use it as context.`, ""];
  s.items.forEach((it, i) => {
    out.push(`## ${it.title}  (${label[it.kind] ?? it.kind}, ${it.saved}${it.by ? `, saved by ${it.by}` : ""})`);
    if (it.summary) out.push(it.summary);
    if (it.notes) out.push(`Why it was saved: ${it.notes.replace(/\s+/g, " ")}`);
    if (it.url) out.push(it.url);
    it.files.forEach((f, j) => out.push(IMG.test(f) ? `![${it.title}](${base()}/s/${token}/f/${i}-${j})` : `File: ${base()}/s/${token}/f/${i}-${j}`));
    out.push("");
  });
  return out.join("\n");
}

const CSS = `body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f3f1ec;color:#1f1d19;margin:0}@media(prefers-color-scheme:dark){body{background:#171613;color:#ece7dd}.c{background:#201e1a!important;border-color:#3a362f!important}.m{color:#a59d8f!important}}
.w{max-width:720px;margin:0 auto;padding:24px 16px 60px}h1{font-size:1.5rem;margin:0 0 4px}.m{color:#6c665b;font-size:.9rem}.c{background:#fffdf9;border:1px solid #dcd6cb;border-radius:14px;overflow:hidden;margin:16px 0}
.c img{display:block;width:100%;height:auto}.c div{padding:14px 16px}.c b{display:block}.c p{margin:6px 0 0}.c a,.m a{color:#2d5a46;word-break:break-all}@media(prefers-color-scheme:dark){.c a,.m a{color:#7fc3a2}}`;

function html(s: Snap, token: string): string {
  const cards = s.items.map((it, i) => {
    const pics = it.files.map((f, j) => IMG.test(f) ? `<img src="/s/${token}/f/${i}-${j}" alt="${esc(it.title)}" loading="lazy">` : "").join("");
    const files = it.files.map((f, j) => IMG.test(f) ? "" : `<p><a href="/s/${token}/f/${i}-${j}">${esc(f.split("/").pop())}</a></p>`).join("");
    return `<article class="c">${pics}<div><b>${esc(it.title)}</b><span class="m">${esc(label[it.kind] ?? it.kind)} · ${esc(it.saved)}${it.by ? " · " + esc(it.by) : ""}</span>${it.summary ? `<p>${esc(it.summary)}</p>` : ""}${it.notes ? `<p>${esc(it.notes)}</p>` : ""}${it.url ? `<p><a href="${esc(it.url)}" rel="noopener nofollow">${esc(it.url)}</a></p>` : ""}${files}</div></article>`;
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(s.name)}</title><link rel="icon" href="/static/icon-32.png"><link rel="alternate" type="text/markdown" href="/s/${token}.md"><style>${CSS}</style><div class="w"><h1>${esc(s.name)}</h1><div class="m">Shared from Recall. Read-only. ${s.items.length} item${s.items.length === 1 ? "" : "s"}. For an agent: <a href="/s/${token}.md">the same thing as text</a>.</div>${cards}</div>`;
}

/** The public side: /s/<token>, /s/<token>.md and /s/<token>/f/<item>-<file>. Returns null for any other address. */
export async function door(req: Request): Promise<Response | null> {
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/s\/([A-Za-z0-9_-]{20,64})(\.md|\/f\/(\d+)-(\d+))?$/);
  if (!m || req.method !== "GET") return null;
  const gone = () => new Response("This link has stopped working. Ask the person who sent it for a new one.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });
  const s = read(m[1]); if (!s) return gone();
  const h = { "x-robots-tag": "noindex, nofollow", "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
  if (m[2] === ".md") return new Response(markdown(s, m[1]), { headers: { ...h, "content-type": "text/markdown; charset=utf-8" } });
  if (!m[2]) return new Response(html(s, m[1]), { headers: { ...h, "content-type": "text/html; charset=utf-8" } });
  const rel = s.items[+m[3]]?.files[+m[4]]; if (!rel) return gone();
  const abs = resolve(join(DATA, rel));
  // Only files that were in the snapshot, and only from this person's own library.
  if (!(abs.startsWith(join(s.dir, "files") + "/") || abs.startsWith(join(s.dir, "vault") + "/")) || !existsSync(abs)) return gone();
  if (IMG.test(abs)) {
    const cache = join(DIR, "cache"); mkdirSync(cache, { recursive: true });
    const out = join(cache, hash(abs) + ".1280.jpg");
    if (!existsSync(out)) { const r = Bun.spawn(jpegArgs(abs, out, 1280, 82), { stdout: "pipe", stderr: "pipe" }); if ((await r.exited) !== 0 || !existsSync(out)) return new Response(Bun.file(abs), { headers: h }); }
    return new Response(Bun.file(out), { headers: { ...h, "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
  }
  return new Response(Bun.file(abs), { headers: h });
}

// People this person has shared with, most recent first, so the next share is one click.
// Kept in their own library folder; never leaves it. Each: a name plus a phone and/or an email.
type Contact = { name: string; phone?: string; email?: string; at: string };
const RF = (p: Person) => join(p.dir, "recipients.json");
const readList = (p: Person): Contact[] => { try { return JSON.parse(readFileSync(RF(p), "utf8")); } catch { return []; } };

export const recipients = (p: Person) => ({ list: readList(p).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30), email: mailer.ready() });

export function remember(p: Person, c: { name?: string; phone?: string; email?: string }) {
  const phone = String(c.phone ?? "").replace(/[^\d+]/g, "").slice(0, 20) || undefined;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email ?? "").trim()) ? String(c.email).trim().toLowerCase().slice(0, 120) : undefined;
  if (!phone && !email) return { ok: false };
  const list = readList(p);
  const hit = list.find((x) => (phone && x.phone === phone) || (email && x.email === email));
  const name = String(c.name ?? "").trim().slice(0, 60);
  if (hit) { hit.at = new Date().toISOString(); if (name) hit.name = name; hit.phone ??= phone; hit.email ??= email; }
  else list.push({ name: name || email || phone!, phone, email, at: new Date().toISOString() });
  writeFileSync(RF(p), JSON.stringify(list.slice(-200)), { mode: 0o600 });
  return { ok: true };
}

const sent = new Map<string, number>(); // emails sent per person per day: a share link goes to people they name, not to a crowd
/** Email the share link to one address the person chose. Without an email key it says so, and the page opens their mail app instead. */
export async function emailLink(p: Person, token: string, to: string) {
  if (!mailer.ready()) return { fallback: true };
  const s = TOKEN.test(token) ? read(token) : null;
  if (!s || s.owner !== p.id) return { error: "That link isn't available." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: "That email address doesn't look right." };
  const day = `${p.id}:${new Date().toISOString().slice(0, 10)}`;
  if ((sent.get(day) ?? 0) >= 20) return { error: "That's 20 emails today. Use Message or WhatsApp for more." };
  sent.set(day, (sent.get(day) ?? 0) + 1);
  const l = links(token);
  try { await mailer.send(to, `${s.name} on Recall`, `${p.name} shared "${s.name}" with you.\n\nOpen it: ${l.page}\n\nRead-only. You don't need a Recall account.`, p.email); }
  catch (e) { console.error(`[share] email failed: ${(e as Error).message}`); return { error: "The email didn't send. Try again." }; }
  return { ok: true };
}
