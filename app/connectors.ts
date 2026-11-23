// Connectors: one list of everything Recall can take from or send to, with what is true about each one right now
// and the one thing left to do to turn it on. The /connectors page shows this list and nothing else.
//
//   Comes in   Granola, Otter      meetings.ts (already built); shown here with their real status
//              Apple Notes         no web API exists, so a script on the Mac reads Notes and saves each note
//                                  (tools/sync-apple-notes.ts)
//              Google Drive        this file: the person signs in once (read-only), then new and changed Docs,
//                                  PDFs and pictures are saved, at most DRIVE_CAP per sync
//              Photos, voice notes the Save to Recall shortcut
//   Goes out   Metricool           social.ts: a draft in the planner, never published, caption written by the person
//              Canva               canva.ts: a file sent to the person's Canva uploads
//
// States: "on" works now · "ready" needs the person's own sign-in (one tap) · "needs-you" needs something only the
// owner can do first (a key, an integration, a script on the Mac) · "shortcut" is covered by the shortcut today.
// Nothing here claims to work when it doesn't: a missing key or secret is reported, never worked around.
//
// Drive sign-in: Google's client id is the one Sign in with Google already uses (library/google.json, or
// GOOGLE_CLIENT_ID). The client secret is new: GOOGLE_CLIENT_SECRET in .env, or ~/.gbrain/serve/google.key.
// In Google Cloud the same client needs <this Recall's address>/connect/drive/callback as a redirect URI and the
// Drive API turned on. A person's Drive sign-in: ~/.gbrain/serve/connectors/<person>/drive.json, owner-only.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DATA } from "./paths.ts";
import { PUBLIC_URL } from "./config.ts";
import * as files from "./connector-store.ts";
import * as meetings from "./meetings.ts";
import * as social from "./social.ts";
import * as canva from "./canva.ts";
import type { Person } from "./identity.ts";

export type State = "on" | "ready" | "needs-you" | "shortcut";
export type Connector = { id: string; name: string; what: string; direction: "in" | "out"; state: State; needs?: string; action?: { label: string; href: string; post?: boolean }; last?: string };
type With = (fn: (req: Request, p: Person) => Promise<Response>) => (req: Request) => Promise<Response>;
export type Saver = (person: Person, input: { notes: string; files: string[]; source: string }) => Promise<unknown>;
const json = (d: unknown, status = 200) => Response.json(d, { status });

// ── Google Drive ─────────────────────────────────────────────────────────────
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DRIVE_CAP = 20;            // files saved per sync
const DRIVE_FIRST_DAYS = Number(Bun.env.DRIVE_FIRST_DAYS ?? 30); // the first sync looks this far back, not at the whole Drive
const DRIVE_MAX_BYTES = 50 * 1024 ** 2; // a bigger file is skipped
const DOC = "application/vnd.google-apps.document";
export const DRIVE_NEEDS = "Google client secret + redirect URI registered";
const BOOT = Date.now();
type Drive = { state?: string; redirect?: string; refresh?: string; connected_at?: string; last_sync?: string; cursor?: string; seen?: Record<string, string>; saved?: number; syncing?: string; last_error?: string };

function googleClient(): { id: string; secret: string } | null {
  let id = Bun.env.GOOGLE_CLIENT_ID ?? "";
  if (!id) try { id = JSON.parse(readFileSync(join(DATA, "library/google.json"), "utf8")).clientId ?? ""; } catch {}
  const secret = Bun.env.GOOGLE_CLIENT_SECRET || files.key("google");
  return id && secret ? { id, secret } : null;
}
export const driveReady = () => !!googleClient();
export function driveStatus(pid: string) { const s = files.read<Drive>(pid, "drive"); return { connected: !!s.refresh, connected_at: s.connected_at, last_sync: s.last_sync, saved: s.saved ?? 0, syncing: !!s.syncing && Date.parse(s.syncing) >= BOOT, error: s.last_error }; }
export function driveDisconnect(pid: string) { files.remove(pid, "drive"); }

/** Google's sign-in page for this person, asking to read their Drive; `redirect` is Recall's callback as their browser sees it. */
export function driveStartUrl(person: { id: string }, redirect: string): string {
  const c = googleClient(); if (!c) throw new Error(DRIVE_NEEDS);
  const state = `${person.id}.${randomBytes(16).toString("hex")}`;
  files.patch<Drive>(person.id, "drive", (s) => { s.state = state; s.redirect = redirect; delete s.last_error; });
  // access_type offline + prompt consent: Google only hands out the long-lived sign-in when asked this way.
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: "code", scope: DRIVE_SCOPE, access_type: "offline", prompt: "consent", state })}`;
}

async function googleToken(form: Record<string, string>): Promise<any> {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Google answered ${r.status}${d.error ? ` (${d.error})` : ""}`); // never the tokens
  return d;
}

/** Back from Google with ?code&state. Only the sign-in that was started for this person can finish. */
export async function driveCallback(code: string, state: string, person: { id: string }): Promise<void> {
  const c = googleClient(); if (!c) throw new Error(DRIVE_NEEDS);
  const s = files.read<Drive>(person.id, "drive");
  if (!code || !s.state || s.state !== state || !state.startsWith(`${person.id}.`)) throw new Error("This sign-in link is old. Tap Connect Google Drive again.");
  const t = await googleToken({ grant_type: "authorization_code", code, client_id: c.id, client_secret: c.secret, redirect_uri: s.redirect ?? "" });
  if (!t.refresh_token && !s.refresh) throw new Error("Google didn't give a lasting sign-in. Tap Connect Google Drive again.");
  files.patch<Drive>(person.id, "drive", (x) => { if (t.refresh_token) x.refresh = t.refresh_token; x.connected_at = new Date().toISOString(); x.seen ??= {}; delete x.state; delete x.last_error; });
}

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime: string; size?: string };
const safeName = (s: string) => s.replace(/[/\\:*?"<>|\n\r]+/g, "-").trim().slice(0, 100) || "Untitled";
const EXT: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/webp": ".webp", "image/gif": ".gif" };

/** Save this person's new and changed Drive files (their own Docs as text, PDFs and pictures as they are).
 *  At most DRIVE_CAP per call, oldest change first, so the next call carries on where this one stopped. */
export async function driveSync(person: Person, save: Saver, fetcher: typeof fetch = fetch): Promise<{ saved: number; error?: string }> {
  const c = googleClient(); if (!c) return { saved: 0, error: DRIVE_NEEDS };
  const s = files.read<Drive>(person.id, "drive");
  if (!s.refresh) return { saved: 0, error: "Google Drive isn't connected." };
  if (s.syncing && Date.parse(s.syncing) >= BOOT && Date.now() - Date.parse(s.syncing) < 30 * 60_000) return { saved: 0 }; // one sync at a time
  files.patch<Drive>(person.id, "drive", (x) => { x.syncing = new Date().toISOString(); });
  const seen = { ...(s.seen ?? {}) }; let saved = 0;
  try {
    let tok: string;
    try { tok = (await googleToken({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: c.id, client_secret: c.secret })).access_token; }
    catch (e) { throw new Error(/invalid_grant/.test(String(e)) ? "Google Drive sign-in expired. Tap Connect Google Drive again." : String((e as Error).message)); }
    const auth = { authorization: `Bearer ${tok}` };
    const since = s.cursor ?? new Date(Date.parse(s.connected_at ?? new Date().toISOString()) - DRIVE_FIRST_DAYS * 864e5).toISOString();
    const q = `modifiedTime >= '${since}' and trashed = false and 'me' in owners and (mimeType = '${DOC}' or mimeType = 'application/pdf' or mimeType contains 'image/')`;
    const list = await fetcher(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, orderBy: "modifiedTime", pageSize: "100", fields: "files(id,name,mimeType,modifiedTime,size)" })}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (!list.ok) throw new Error(`Google Drive answered ${list.status}${list.status === 403 ? ". Check the Drive API is turned on for this Google project." : ""}`);
    const listed = (((await list.json()) as any).files ?? []) as DriveFile[];
    const fresh = listed.filter((f) => seen[f.id] !== f.modifiedTime).slice(0, DRIVE_CAP);
    console.log(`[drive] ${person.id}: ${fresh.length} to save of ${listed.length} listed`);
    for (const f of fresh) {
      const done = () => { seen[f.id] = f.modifiedTime; files.patch<Drive>(person.id, "drive", (x) => { x.seen = seen; x.cursor = f.modifiedTime; }); };
      if (Number(f.size ?? 0) > DRIVE_MAX_BYTES) { done(); continue; }
      const isDoc = f.mimeType === DOC;
      const r = await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}${isDoc ? "/export?mimeType=text%2Fplain" : "?alt=media"}`, { headers: auth, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) { console.error(`[drive] ${person.id}: one file not fetched (${r.status})`); if (r.status === 401 || r.status === 429 || r.status >= 500) break; done(); continue; } // a passing failure is tried again next sync
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!bytes.length) { done(); continue; }
      const tmp = join(tmpdir(), `drive-${person.id}-${f.id.replace(/[^\w-]/g, "_")}`); mkdirSync(tmp, { recursive: true });
      const base = safeName(f.name), ext = isDoc ? ".txt" : EXT[f.mimeType] ?? "";
      const path = join(tmp, ext && !base.toLowerCase().endsWith(ext) ? base + ext : base); writeFileSync(path, bytes);
      try { await save(person, { notes: `From Google Drive: ${f.name}`, files: [path], source: `drive:${f.id}` }); }
      finally { rmSync(tmp, { recursive: true, force: true }); }
      saved++; done(); files.patch<Drive>(person.id, "drive", (x) => { x.saved = (x.saved ?? 0) + 1; }); // a crash mid-run never saves a file twice
    }
    files.patch<Drive>(person.id, "drive", (x) => { x.last_sync = new Date().toISOString(); delete x.last_error; });
    return { saved };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 200);
    files.patch<Drive>(person.id, "drive", (x) => { x.last_error = error; });
    console.error(`[drive] ${person.id}: ${error}`);
    return { saved, error };
  } finally { files.patch<Drive>(person.id, "drive", (x) => { delete x.syncing; }); }
}

// ── The list ─────────────────────────────────────────────────────────────────
/** The Mac script's own record, when this Recall runs on the same Mac. On a server it can't be seen, and that's said. */
function appleNotesLast(): string | undefined {
  try { return JSON.parse(readFileSync(join(Bun.env.RECALL_KEYS_DIR ?? join(Bun.env.HOME ?? "", ".gbrain/serve"), "apple-notes-sync.json"), "utf8")).last_sync || undefined; } catch { return undefined; }
}

/** Every connector, as it stands for this person. Reads files only: nothing is sent to any service, and nothing throws. */
export function all(person: { id: string }, opts: { keyBoxes?: string[] } = {}): Connector[] {
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const box = (name: string, label: string) => opts.keyBoxes?.includes(name) ? { action: { label, href: `/settings?key=${name}` } } : {};
  const out: Connector[] = [];
  for (const v of Object.keys(meetings.VENDORS) as meetings.Vendor[]) {
    const name = meetings.VENDORS[v].name, st = safe(() => meetings.status(v, person.id), { connected: false } as ReturnType<typeof meetings.status>);
    const connect = { label: `Connect ${name}`, href: `/connect/${v}` };
    out.push({ id: v, name, what: `Your ${name} meetings are saved with their notes and transcript.`, direction: "in",
      ...(st.error ? { state: "ready", needs: st.error, action: connect } : st.connected ? { state: "on", last: st.last_sync } : { state: "ready", action: connect }) });
  }
  const notesLast = safe(appleNotesLast, undefined);
  out.push({ id: "apple-notes", name: "Apple Notes", what: "Notes you write or change on the Mac are saved. Locked notes are skipped.", direction: "in",
    ...(notesLast ? { state: "on", last: notesLast } : { state: "needs-you", needs: "Run tools/sync-apple-notes.ts on the Mac and allow it to read Notes" }) });
  const d = safe(() => driveStatus(person.id), { connected: false, saved: 0, syncing: false } as ReturnType<typeof driveStatus>);
  const connectDrive = { label: "Connect Google Drive", href: "/connect/drive" };
  out.push({ id: "drive", name: "Google Drive", what: "Your own Docs, PDFs and pictures in Drive are saved when they are new or changed. Recall can only read.", direction: "in",
    ...(!safe(driveReady, false) ? { state: "needs-you", needs: DRIVE_NEEDS, ...box("google", "Add the Google client secret") }
      : d.error ? { state: "ready", needs: d.error, action: connectDrive, last: d.last_sync }
      : d.connected ? { state: "on", last: d.last_sync, action: { label: "Sync now", href: "/api/connectors/drive/sync", post: true } }
      : { state: "ready", action: connectDrive }) });
  out.push({ id: "photos", name: "Photos album \"Recall\"", what: "Uses the Save to Recall shortcut today.", direction: "in", state: "shortcut", action: { label: "Open the guide", href: "/guide" } });
  out.push({ id: "voice", name: "Voice notes", what: "Uses the Save to Recall shortcut today.", direction: "in", state: "shortcut", action: { label: "Open the guide", href: "/guide" } });
  out.push({ id: "metricool", name: "Metricool", what: "Sends a picture or video to Metricool as a draft for Instagram, LinkedIn, Facebook or TikTok. It is never published from here, and you write the caption.", direction: "out",
    ...(safe(social.ready, false) ? { state: "on", last: files.keySavedAt("metricool") } : { state: "needs-you", needs: social.NEEDS, ...box("metricool", "Add the Metricool key") }) });
  const cv = safe(() => canva.status(person.id), { connected: false } as ReturnType<typeof canva.status>);
  const connectCanva = { label: "Connect Canva", href: "/connect/canva" };
  out.push({ id: "canva", name: "Canva", what: "Sends a saved picture to your Canva uploads.", direction: "out",
    ...(!safe(canva.ready, false) ? { state: "needs-you", needs: canva.NEEDS, ...box("canva", "Add the Canva client id and secret") }
      : cv.error ? { state: "ready", needs: cv.error, action: connectCanva }
      : cv.connected ? { state: "on", last: cv.last ?? cv.connected_at }
      : { state: "ready", action: connectCanva }) });
  return out as Connector[];
}

// ── Routes ───────────────────────────────────────────────────────────────────
// deps.save puts a file into the person's library the way every other save does (server.ts: queueSave).
// deps.keyBoxes names the keys the Keys page has a box for; a "needs you" card only links there when its box exists.
export function connectorRoutes(withPerson: With, deps: { save: Saver; keyBoxes?: string[] }) {
  const back = (q: string) => Response.redirect(`${PUBLIC_URL}/connectors?${q}`, 302);
  return {
    "/api/connectors/all": { GET: withPerson(async (_req, p) => json(all(p, { keyBoxes: deps.keyBoxes }))) },

    "/connect/drive": withPerson(async (_req, p) => {
      try { return Response.redirect(driveStartUrl(p, `${PUBLIC_URL}/connect/drive/callback`), 302); }
      catch (e) { return back(`problem=${encodeURIComponent(`Google Drive needs: ${(e as Error).message}`)}`); }
    }),
    "/connect/drive/callback": withPerson(async (req, p) => {
      const q = new URL(req.url).searchParams;
      if (q.get("error")) return back("cancelled=drive");
      try { await driveCallback(q.get("code") ?? "", q.get("state") ?? "", p); }
      catch (e) { console.error(`[drive] ${p.id} return: ${String((e as Error).message).slice(0, 200)}`); return back(`problem=${encodeURIComponent(String((e as Error).message).slice(0, 160))}`); }
      driveSync(p, deps.save).catch(() => {}); // the first files start arriving right away
      return back("connected=drive");
    }),
    "/api/connectors/drive/sync": { POST: withPerson(async (_req, p) => {
      if (!driveStatus(p.id).connected) return json({ error: driveReady() ? "Google Drive isn't connected." : DRIVE_NEEDS }, 400);
      driveSync(p, deps.save).catch(() => {}); return json({ ok: true, started: true });
    }) },
    "/api/connectors/drive/disconnect": { POST: withPerson(async (_req, p) => { driveDisconnect(p.id); return json({ ok: true }); }) },

    "/connect/canva": withPerson(async (_req, p) => {
      try { return Response.redirect(canva.startUrl(p, `${PUBLIC_URL}/connect/canva/callback`), 302); }
      catch (e) { return back(`problem=${encodeURIComponent(`Canva needs: ${(e as Error).message}`)}`); }
    }),
    "/connect/canva/callback": withPerson(async (req, p) => {
      const q = new URL(req.url).searchParams;
      if (q.get("error")) return back("cancelled=canva");
      try { await canva.callback(p, q.get("state") ?? "", q.get("code") ?? ""); }
      catch (e) { console.error(`[canva] ${p.id} return: ${String((e as Error).message).slice(0, 200)}`); return back(`problem=${encodeURIComponent(String((e as Error).message).slice(0, 160))}`); }
      return back("connected=canva");
    }),
    "/api/connectors/canva/disconnect": { POST: withPerson(async (_req, p) => { canva.disconnect(p.id); return json({ ok: true }); }) },
  };
}
