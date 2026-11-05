// The public door: how teammates reach the library from any browser at the install's web address (RECALL_PUBLIC_URL).
// It listens on its own port (3346) that only the tunnel points at, so nothing arriving here is ever
// treated as this Mac or the private network. Ways in: Google sign-in (google.ts, with the team link or a
// board invite for newcomers) and the older personal invite link (/join/<token>); each leaves a long-lived
// cookie on that browser. Tokens and session ids are stored hashed, so the file on disk can't be used to get in.

import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { personByEmail } from "./identity.ts";
import { read, update } from "./store.ts";
import { addMember, defaultId } from "./board.ts";

import { DATA as ROOT } from "./paths.ts";
import { PUBLIC_URL, OWNER_NAME } from "./config.ts";
const FILE = join(ROOT, "library/invites.json");
const COOKIE = "recall_sid";
export const TEAM_COOKIE = "recall_team";
export const FRIEND_COOKIE = "recall_friend"; // the friends link: an account of their own, no team board
export const BOARD_COOKIE = "recall_board"; // a board invite (/b/<token>) waiting for this browser's first sign-in
const YEAR = 365 * 24 * 3600;

type Invite = { name: string; email: string; created: string; uses: number; maxUses: number };
type Session = { email: string; created: string; seen: string };
type Store = { invites: Record<string, Invite>; sessions: Record<string, Session> };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const EMPTY: Store = { invites: {}, sessions: {} };
// Reads that fail count as "nobody" for this request; writes re-read inside a lock and refuse a bad file,
// so one torn read can never write an empty file over everyone's sessions.
async function load(): Promise<Store> { try { return read<Store>(FILE, structuredClone(EMPTY)); } catch (e) { console.error(`[door] invites.json unreadable: ${(e as Error).message}`); return structuredClone(EMPTY); } }
const change = (fn: (s: Store) => void) => update<Store>(FILE, EMPTY, (s) => { fn(s); });

/** Sign one person out on every browser (`cl welcome-reset --sign-out`). Returns how many sign-ins ended. */
export async function endSessions(email: string): Promise<number> {
  let n = 0; email = email.trim().toLowerCase();
  await change((s) => { for (const [k, r] of Object.entries(s.sessions)) if (r.email.toLowerCase() === email) { delete s.sessions[k]; n++; } });
  return n;
}

/** A new invite for one person. Works on up to `maxUses` browsers (laptop, phone, desktop). */
export async function mintInvite(name: string, email?: string, maxUses = 3): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const login = (email ?? `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}@invite.recall`).toLowerCase();
  await change((s) => { s.invites[hash(token)] = { name: name.trim(), email: login, created: new Date().toISOString(), uses: 0, maxUses }; });
  return token;
}

function cookieSid(req: Request) { return req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`))?.[1] ?? ""; }

/** The login behind this browser's cookie, or null. */
export async function sessionEmail(req: Request): Promise<string | null> {
  const sid = cookieSid(req); if (!sid) return null;
  const s = await load(); const row = s.sessions[hash(sid)];
  if (!row) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (row.seen.slice(0, 10) !== today) await change((f) => { const r = f.sessions[hash(sid)]; if (r) r.seen = new Date().toISOString(); }).catch(() => {});
  return row.email;
}

export const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recall</title><link rel="icon" href="/static/icon-32.png"><link rel="apple-touch-icon" href="/static/icon-180.png">
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f3f4f1;color:#1d2420;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px}
@media(prefers-color-scheme:dark){body{background:#141917;color:#e6ebe7}}main{max-width:420px}h1{font-size:1.6rem;margin:0 0 8px}
.logo{display:block;width:112px;height:112px;border-radius:26px;margin:0 0 21px;box-shadow:0 0 34px rgba(255,150,30,.35),0 8px 21px rgba(0,0,0,.25)}</style>
<main><img class="logo" src="/static/icon-512.png" alt=""><h1>${title}</h1><p>${body}</p></main>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** A signed-in browser: a new session for this login. Returns the Set-Cookie value. */
export async function newSession(email: string): Promise<string> {
  const sid = randomBytes(32).toString("base64url");
  await change((s) => { s.sessions[hash(sid)] = { email, created: new Date().toISOString(), seen: new Date().toISOString() }; });
  return `${COOKIE}=${sid}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`;
}

/** GET /join/<token>: a page with one "Open Recall" button. Nothing is spent here, so link previews in
 * Messages or Mail (which fetch the link before anyone taps it) can't use up an invite. */
export async function joinPage(token: string, req: Request): Promise<Response> {
  const s = await load(); const inv = s.invites[hash(token)];
  if (!inv) return page("This link doesn't work", `It may have been mistyped or replaced. Ask ${OWNER_NAME} for a new invite link.`, 404);
  const already = await sessionEmail(req);
  if (already === inv.email) return new Response(null, { status: 302, headers: { location: "/" } });
  if (inv.uses >= inv.maxUses) return page("This link has been used up", `It has already opened Recall on its limit of browsers. Ask ${OWNER_NAME} for a new one.`, 410);
  return page(`Welcome, ${esc(inv.name)}`, `This opens your Recall library in this browser and keeps you signed in here.
<form method="post"><button style="margin-top:18px;font:inherit;font-weight:600;padding:14px 22px;border:0;border-radius:12px;background:#2d5a46;color:#fff;width:100%;cursor:pointer">Open Recall</button></form>`);
}

/** POST /join/<token>: spend one use of the invite, create the person's library if needed, set the cookie. */
export async function join_(token: string): Promise<Response> {
  const s = await load(); const inv = s.invites[hash(token)];
  if (!inv) return page("This link doesn't work", `Ask ${OWNER_NAME} for a new invite link.`, 404);
  if (inv.uses >= inv.maxUses) return page("This link has been used up", `It already opened Recall on its limit of browsers. Ask ${OWNER_NAME} for a new one.`, 410);
  const person = await personByEmail(inv.email, inv.name); // first visit makes their library
  const sid = randomBytes(32).toString("base64url");
  let used = -1; // the library setup above can take a moment; spend the use on a fresh read
  await change((fresh) => {
    const inv2 = fresh.invites[hash(token)]; if (!inv2 || inv2.uses >= inv2.maxUses) return;
    used = inv2.uses += 1;
    fresh.sessions[hash(sid)] = { email: inv.email, created: new Date().toISOString(), seen: new Date().toISOString() };
  });
  if (used < 0) return page("This link has been used up", `Ask ${OWNER_NAME} for a new one.`, 410);
  await addMember(defaultId(), person.id, "invite").catch((e) => console.error(`[door] team board: ${e.message}`)); // Max's personal invites are to the team
  console.log(`[door] ${inv.name} joined on a browser (${used}/${inv.maxUses})`);
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `${COOKIE}=${sid}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax` } });
}

export const notSignedIn = () => page("Recall", `This browser isn't signed in yet. Open your invite link in this browser, or paste it here:
<form id="paste" style="margin-top:16px;display:grid;gap:10px"><input id="link" type="url" placeholder="${PUBLIC_URL}/join/…" autocomplete="off" style="font:inherit;padding:12px;border-radius:10px;border:1px solid #9aa69f"><button style="font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:#2d5a46;color:#fff;cursor:pointer">Open</button></form>
<p style="color:#6b766f;font-size:.9rem;margin-top:14px">No link yet? Ask ${OWNER_NAME} for one.</p>
<script>document.getElementById('paste').onsubmit=(e)=>{e.preventDefault();const m=document.getElementById('link').value.match(/join\/([A-Za-z0-9_-]{20,64})/);if(m)location.href='/join/'+m[1];else document.getElementById('link').setCustomValidity('That doesn\'t look like an invite link.'),document.getElementById('link').reportValidity();};</script>`, 401);
export const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
