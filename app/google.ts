// Sign in with Google at the public door.
//
//   The team link (/team/<code>, from `cl team-link`) lets a new person in: it leaves a "team" cookie on
//   that browser, and their first Google sign-in creates their own library and puts them on the team board.
//   A board invite (/b/<token>) does the same for one board: it leaves a "board" cookie, and sign-in joins it.
//   The friends link (/invite/<code>) lets a new person in too, with their own library and no team board
//   (Max, 4 Nov 2026: he sends Recall to friends who aren't on True Nature).
//   Anyone already in the library (people.json) can sign in with Google on any browser, link or not.
//   A Google account that is none of these is told to open the link they were sent.
//
// Google's ID token is checked here: signature against Google's published keys, audience = our client id,
// issuer, expiry, and a verified email. Config: library/google.json {"clientId": "…"} (not a secret).

import { join } from "node:path";
import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DATA as ROOT, TWIN } from "./paths.ts";
import { personByEmail, listPeople, isWelcomed, deviceKind, setPicture } from "./identity.ts";
import { newSession, page, esc, TEAM_COOKIE, BOARD_COOKIE, FRIEND_COOKIE } from "./door.ts";
import { acceptInvite, addMember, defaultId, inviteInfo, AVATARS } from "./board.ts";
import { OWNER_NAME, OPERATOR, CONTACT_EMAIL } from "./config.ts";

const CONFIG = join(ROOT, "library/google.json");
const TEAM = join(ROOT, "library/team.json");
const FRIENDS = join(ROOT, "library/friends.json");
const MONTH = 30 * 24 * 3600;

export async function clientId(): Promise<string | null> {
  try { return (JSON.parse(await Bun.file(CONFIG).text()).clientId as string) || null; } catch { return null; }
}

/** The code inside a link: made once; renew replaces it (old links stop working). */
async function linkCode(file: string, renew: boolean): Promise<string> {
  if (!renew) { try { const c = JSON.parse(await Bun.file(file).text()).code; if (c) return c; } catch {} }
  const code = randomBytes(18).toString("base64url");
  await Bun.write(file, JSON.stringify({ code, created: new Date().toISOString() }, null, 2) + "\n");
  return code;
}
/** The team code inside the team link (`cl team-link --new` replaces it). */
export const teamCode = (renew = false) => linkCode(TEAM, renew);
/** The code inside the friends link. */
export const friendCode = (renew = false) => linkCode(FRIENDS, renew);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (req: Request, name: string) => req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`))?.[1] ?? "";

/** GET /team/<code> or /invite/<code>: remember the pass on this browser, then show the sign-in page. */
export async function teamEntry(code: string, kind: "team" | "friend" = "team"): Promise<Response> {
  if (!same(code, await (kind === "team" ? teamCode() : friendCode()))) return page("This link doesn't work", "It may be old or mistyped. Ask the person who sent it for a new link.", 404);
  return new Response(null, { status: 302, headers: { location: "/signin", "set-cookie": `${kind === "team" ? TEAM_COOKIE : FRIEND_COOKIE}=${code}; Path=/; Max-Age=${MONTH}; HttpOnly; Secure; SameSite=Lax` } });
}

/** The sign-in page: one Google button. */
export async function signInPage(req: Request, note = "", status = 200): Promise<Response> {
  const id = await clientId();
  const joining = same(cookie(req, TEAM_COOKIE), await teamCode()) || same(cookie(req, FRIEND_COOKIE), await friendCode()) || !!inviteInfo(cookie(req, BOARD_COOKIE));
  const lead = note || (joining ? "Sign in with your Google account. Your own library is created the first time." : "Sign in with your Google account.");
  const google = id ? `<div id="g" style="margin-top:18px;min-height:44px"></div>
<p id="err" style="color:#9b2d2d;min-height:1.2em"></p>
<script src="https://accounts.google.com/gsi/client" async></script>
<script>
window.onload = () => {
  google.accounts.id.initialize({ client_id: ${JSON.stringify(id)}, ux_mode: "popup", callback: async (r) => {
    const res = await fetch("/auth/google", { method: "POST", headers: { "content-type": "application/json", "x-recall": "1" }, body: JSON.stringify({ credential: r.credential }) });
    if (res.ok) location.href = (await res.json().catch(() => ({}))).next || "/"; else document.getElementById("err").textContent = (await res.json().catch(() => ({}))).error || "Sign-in didn't work. Try again.";
  } });
  google.accounts.id.renderButton(document.getElementById("g"), { theme: "outline", size: "large", text: "signin_with", width: 320 });
};
</script>` : `<p style="color:#6b766f">Google sign-in isn't set up yet.</p>`;
  return page("Recall", `${esc(lead)}${google}`, status);
}

// Google's signing keys, cached for an hour.
let keys: { at: number; jwks: any[] } | null = null;
async function googleKeys(): Promise<any[]> {
  if (TWIN && Bun.env.RECALL_TEST_JWKS) return JSON.parse(await Bun.file(Bun.env.RECALL_TEST_JWKS).text()).keys; // twin tests only
  if (keys && Date.now() - keys.at < 3600_000) return keys.jwks;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10_000) });
  keys = { at: Date.now(), jwks: (await r.json()).keys };
  return keys.jwks;
}
const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Check a Google ID token. Returns its claims, or throws. */
export async function verifyIdToken(jwt: string, aud: string, jwks?: any[]): Promise<any> {
  const [h, p, sig] = jwt.split("."); if (!h || !p || !sig) throw new Error("malformed token");
  const header = JSON.parse(b64(h).toString()); const claims = JSON.parse(b64(p).toString());
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwk = (jwks ?? await googleKeys()).find((k) => k.kid === header.kid); if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(sig), new TextEncoder().encode(`${h}.${p}`)))) throw new Error("bad signature");
  if (claims.aud !== aud) throw new Error("token is for another app");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("not from Google");
  if (!(claims.exp * 1000 > Date.now())) throw new Error("token expired");
  if (!claims.email || claims.email_verified !== true) throw new Error("email not verified");
  return claims;
}

/** GET /privacy: public, no sign-in. Wording approved by Max on 31 Oct 2026, voice line 2 Nov, profile picture, Visualize and Deepgram lines 3 Nov 2026, first line 4 Nov 2026 (his words: friends use Recall too); change it only with his OK. */
export const privacyPage = () => page("Recall privacy", `Recall is a visual database for inspiration and creation, run by ${OPERATOR}.</p>
<p>When you sign in with Google, Recall receives your name, email address and profile picture. It uses them only to open your own library and to show your picture beside your saves on dream boards you belong to.</p>
<p>What you save stays on ${OWNER_NAME}'s computer. It is not sold or shared. When you speak a note in the Chrome extension, your voice is turned into text by Chrome's own speech service from Google. Nothing else you save is sent to any AI service outside that computer.</p>
${existsSync(join(Bun.env.HOME ?? "", ".gbrain/serve/deepgram.key")) ? "<p>When you speak a note, your voice is sent to Deepgram to turn it into words. Nothing else you save is sent.</p>" : ""}
<p>When your team uses Visualize, the pictures and words you put into it are sent to Higgsfield, or to OpenAI, to make the image or video. Nothing else you save is sent.</p>
<p>To have your library deleted, email ${CONTACT_EMAIL}.`);

/** POST /auth/google {credential}: sign this browser in. */
export async function googleSignIn(req: Request): Promise<Response> {
  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  // Only our own sign-in page can post here (a cross-site form can't set this header).
  if (req.headers.get("x-recall") !== "1") return fail("Sign in from the Recall page.", 403);
  const id = await clientId(); if (!id) return fail("Google sign-in isn't set up yet.", 503);
  const { credential } = await req.json().catch(() => ({}));
  let claims: any;
  try { claims = await verifyIdToken(String(credential ?? ""), id); } catch (e) { return fail(`Google sign-in couldn't be checked (${(e as Error).message}).`, 401); }
  const email = String(claims.email).toLowerCase();
  const known = !!(await listPeople()).people[email];
  const team = same(cookie(req, TEAM_COOKIE), await teamCode());
  const boardToken = cookie(req, BOARD_COOKIE); const invited = !!boardToken && !!inviteInfo(boardToken); // a board invite also lets a new person in
  const friend = same(cookie(req, FRIEND_COOKIE), await friendCode());
  const joining = team || invited || friend;
  if (!known && !joining) return fail(`${email} doesn't have a Recall account yet. Open the invite link you were sent, then sign in again.`, 403);
  let person;
  try { person = await personByEmail(email, claims.given_name || claims.name || undefined); } // first time: their own library
  catch (e) { console.error(`[door] couldn't create a library for ${email}: ${(e as Error).message}`); return fail("Your library couldn't be set up just now. Try again in a minute; if it keeps happening, tell Max.", 503); }
  console.log(`[door] ${person.name} signed in with Google (${known ? "returning" : "new"})`);
  // The team link is the way onto the team board; a board invite is the way onto that board (and only that one).
  if (team) await addMember(defaultId(), person.id, "team link").catch((e) => console.error(`[door] team board: ${e.message}`));
  const joined = invited ? await acceptInvite(boardToken, person.id).catch(() => null) : null;
  if (joined) console.log(`[boards] ${person.id} joined ${joined.board} with an invite`);
  await rememberPicture(email, person.id, person.email === email, claims.picture).catch(() => {});
  // Until a person has finished the welcome page on this kind of device (it adds the Recall shortcut there), sign-in
  // leads there. After that, straight in (onto the board they were invited to, if any).
  const welcomed = isWelcomed((await listPeople()).people[person.email], deviceKind(req.headers.get("user-agent") ?? ""));
  const headers = new Headers({ "set-cookie": await newSession(email) });
  if (boardToken) headers.append("set-cookie", `${BOARD_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return Response.json({ ok: true, next: !welcomed ? "/welcome" : joined ? `/?board=${encodeURIComponent(joined.board)}` : "/" }, { headers });
}

// ── Pictures for team boards ───────────────────────────────────────────────────
// Off until Max OKs saying so on the privacy page: library/settings.json {"avatars": true}.
export function avatarsOn(): boolean { try { return !!JSON.parse(readFileSync(join(ROOT, "library/settings.json"), "utf8")).avatars; } catch { return false; } }

/** Google's picture address, if that's what it is: https on googleusercontent.com and nothing else, since this
 *  server fetches it. Asks for 192px (Google sends 96px), sharp enough for a small round picture on a phone. */
export function pictureUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? ""));
    if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
    if (u.hostname !== "googleusercontent.com" && !u.hostname.endsWith(".googleusercontent.com")) return null;
    u.pathname = u.pathname.replace(/=s\d+(-c)?$/, "=s192-c");
    return u.toString();
  } catch { return null; }
}
export const avatarType = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
  : b[0] === 0x47 && b[1] === 0x49 ? "image/gif" : b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? "image/webp" : null;

/** Download a person's picture once into library/avatars/<personId>.jpg. No redirects (the address was checked),
 *  a short timeout, at most 1 MB, and only real image bytes are kept. */
export async function saveAvatar(personId: string, url: string): Promise<boolean> {
  const safe = pictureUrl(url); if (!safe || !/^[a-z0-9-]+$/.test(personId)) return false;
  const r = await fetch(safe, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`picture: HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > 1_000_000) throw new Error("picture too large");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 1_000_000 || !avatarType(bytes)) throw new Error("not a picture");
  mkdirSync(AVATARS, { recursive: true });
  const out = join(AVATARS, `${personId}.jpg`), tmp = `${out}.${process.pid}.tmp`;
  await Bun.write(tmp, bytes); renameSync(tmp, out);
  return true;
}

/** At sign-in: keep the picture address, and fetch the picture the first time (or when the main account's changes). */
async function rememberPicture(email: string, personId: string, isMain: boolean, raw: unknown) {
  const url = avatarsOn() ? pictureUrl(raw) : null; if (!url) return;
  const before = (await listPeople()).people[email]?.picture;
  if (before !== url) await setPicture(email, url).catch((e) => console.error(`[door] picture: ${e.message}`));
  if (!existsSync(join(AVATARS, `${personId}.jpg`)) || (isMain && before !== url))
    saveAvatar(personId, url).catch((e) => console.error(`[door] ${personId}'s picture: ${(e as Error).message}`)); // never holds up sign-in
}
