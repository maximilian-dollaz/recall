// Canva: a picture saved in Recall can be sent to the person's Canva uploads, ready to drop into a design.
// Canva has no shared key: the owner creates an integration in Canva's developer portal (canva.com/developers,
// "Your integrations"), which gives a client id and secret, and each person then signs in to Canva once.
//
//   The integration   ~/.gbrain/serve/canva.key holds "clientId:clientSecret" (or CANVA_CLIENT_ID and
//                     CANVA_CLIENT_SECRET in .env). In the portal: scopes asset:read and asset:write, and the
//                     redirect URL <this Recall's address>/connect/canva/callback.
//   A person's sign-in  ~/.gbrain/serve/connectors/<person>/canva.json, owner-only. Canva's refresh tokens work
//                     once each, so the new one is written every time a token is renewed.
//
// Canva Connect API (canva.dev/docs/connect): sign-in at www.canva.com/api/oauth/authorize with PKCE (S256),
// tokens at api.canva.com/rest/v1/oauth/token with the client id and secret as Basic auth, and uploads as a job:
// POST /rest/v1/asset-uploads with the file's bytes and its name (base64) in the Asset-Upload-Metadata header.
// Written without an integration to test against: lines marked UNVERIFIED follow the docs but have not run live.

import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import * as files from "./connector-store.ts";

const AUTHORIZE = "https://www.canva.com/api/oauth/authorize";
const API = "https://api.canva.com/rest/v1";
const SCOPE = "asset:read asset:write";
export const NEEDS = "A Canva key, added by the owner";
type Who = { id: string };
type Stored = { state?: string; verifier?: string; redirect?: string; access?: string; access_until?: number; refresh?: string; connected_at?: string; last_upload?: string; last_error?: string };

function client(): { id: string; secret: string } | null {
  const [kid, ...rest] = files.key("canva").split(":");
  const id = Bun.env.CANVA_CLIENT_ID || kid?.trim() || "", secret = Bun.env.CANVA_CLIENT_SECRET || rest.join(":").trim();
  return id && secret ? { id, secret } : null;
}
/** True when this install has a Canva integration to sign people in with. */
export const ready = () => !!client();
export function status(pid: string) { const s = files.read<Stored>(pid, "canva"); return { connected: !!s.refresh, connected_at: s.connected_at, last: s.last_upload, error: s.last_error }; }
export function disconnect(pid: string) { files.remove(pid, "canva"); }

/** Canva's sign-in page for this person; `redirect` is Recall's callback as their browser sees it. */
export function startUrl(person: Who, redirect: string): string {
  const c = client(); if (!c) throw new Error(NEEDS);
  const verifier = randomBytes(48).toString("base64url"), state = `${person.id}.${randomBytes(16).toString("hex")}`;
  files.patch<Stored>(person.id, "canva", (s) => { s.state = state; s.verifier = verifier; s.redirect = redirect; delete s.last_error; });
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({ code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: SCOPE, response_type: "code", client_id: c.id, state, redirect_uri: redirect }).toString();
  return u.toString();
}

async function token(c: { id: string; secret: string }, form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Canva sign-in answered ${r.status}${d.code ? ` (${d.code})` : d.error ? ` (${d.error})` : ""}`); // never the tokens
  return d;
}
function keep(pid: string, t: { access_token: string; refresh_token?: string; expires_in?: number }) {
  files.patch<Stored>(pid, "canva", (s) => { s.access = t.access_token; s.access_until = Date.now() + ((t.expires_in ?? 3600) - 60) * 1000; if (t.refresh_token) s.refresh = t.refresh_token; s.connected_at ??= new Date().toISOString(); delete s.state; delete s.verifier; delete s.last_error; });
}

/** Back from Canva with ?state&code. Only the sign-in that was started for this person can finish. */
export async function callback(person: Who, state: string, code: string): Promise<void> {
  const c = client(); if (!c) throw new Error(NEEDS);
  const s = files.read<Stored>(person.id, "canva");
  if (!s.state || s.state !== state || !state.startsWith(`${person.id}.`) || !s.verifier || !code) throw new Error("This sign-in link is old. Tap Connect Canva again.");
  keep(person.id, await token(c, { grant_type: "authorization_code", code, code_verifier: s.verifier, ...(s.redirect ? { redirect_uri: s.redirect } : {}) }));
}

async function access(pid: string): Promise<string> {
  const c = client(); if (!c) throw new Error(NEEDS);
  const s = files.read<Stored>(pid, "canva");
  if (s.access && (s.access_until ?? 0) > Date.now()) return s.access;
  if (!s.refresh) throw new Error("Canva isn't connected.");
  try { const t = await token(c, { grant_type: "refresh_token", refresh_token: s.refresh }); keep(pid, t); return t.access_token; }
  catch (e) { files.patch<Stored>(pid, "canva", (x) => { x.last_error = "Canva sign-in expired. Tap Connect Canva again."; }); throw e; }
}

/** Send one file to this person's Canva uploads. Waits for Canva to finish taking it in (up to a minute). */
export async function uploadAsset(person: Who, filePath: string, name?: string): Promise<{ ok: boolean; assetId?: string; error?: string }> {
  try {
    const f = Bun.file(filePath); if (!(await f.exists())) return { ok: false, error: "That file isn't there any more." };
    const tok = await access(person.id);
    const title = [...(name || basename(filePath)).trim()].slice(0, 50).join("") || "From Recall"; // Canva allows 1 to 50 characters
    const r = await fetch(`${API}/asset-uploads`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream", "Asset-Upload-Metadata": JSON.stringify({ name_base64: Buffer.from(title, "utf8").toString("base64") }) }, body: f, signal: AbortSignal.timeout(120_000) });
    let d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Canva answered ${r.status}${d.code ? ` (${d.code})` : ""}`);
    // UNVERIFIED: the job is read back at GET /asset-uploads/<job id> (the upload page links to it without printing the path).
    for (let i = 0; i < 30 && d.job?.status === "in_progress"; i++) {
      await Bun.sleep(2000);
      d = await (await fetch(`${API}/asset-uploads/${encodeURIComponent(d.job.id)}`, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20_000) })).json().catch(() => ({}));
    }
    if (d.job?.status !== "success") throw new Error(d.job?.error?.message ? `Canva didn't take the file: ${String(d.job.error.message).slice(0, 160)}` : "Canva is still working on the file. Look in Canva's uploads in a minute.");
    files.patch<Stored>(person.id, "canva", (s) => { s.last_upload = new Date().toISOString(); delete s.last_error; });
    console.log(`[canva] ${person.id}: one file sent to Canva`);
    return { ok: true, assetId: d.job.asset?.id };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 240);
    console.error(`[canva] ${person.id}: ${error}`);
    return { ok: false, error };
  }
}
