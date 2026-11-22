// Meeting recorders (Granola, Otter): each person's meetings flow into their own library, on their own.
// Connect: GET /connect/<vendor> sends the browser to the vendor's sign-in (OAuth through its MCP server, where
// Recall registers itself as a client); the vendor sends it back to /connect/<vendor>/callback, which the public
// door finishes without needing a Recall session (an iPhone home-screen app keeps its own sign-in).
// Sync: every half hour, each connected person's new meetings are fetched (notes or summary, plus the full
// transcript when the plan includes it) and saved like any other save, one item per meeting. The first sync
// takes the whole history, so the librarian files every past meeting and pieces.ts pulls out its ideas.
// Sign-ins live outside every library (never in git or GBrain): ~/.gbrain/serve/connectors/<person>/<vendor>.json, 600.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DATA, TWIN } from "./paths.ts";

export const VENDORS = {
  granola: { name: "Granola", url: "https://mcp.granola.ai/mcp", scope: undefined as string | undefined },
  otter: { name: "Otter", url: "https://mcp.otter.ai/mcp", scope: "profile:read conversations:read" },
};
export type Vendor = keyof typeof VENDORS;
export const isVendor = (v: unknown): v is Vendor => typeof v === "string" && v in VENDORS;

const DIR = Bun.env.RECALL_CONNECTORS ?? (TWIN ? join(DATA, "connectors") : join(Bun.env.HOME ?? "", ".gbrain/serve/connectors"));
/** The first sync takes everything since this date (the whole history, in practice). */
const HISTORY_FROM = "2015-01-01";
const BOOT = Date.now();

type Who = { id: string; name: string; email: string };
type Stored = { redirect?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string;
  connected_at?: string; last_sync?: string; last_error?: string; seen?: string[]; saved?: number; syncing?: string };

const file = (pid: string, v: Vendor) => join(DIR, pid.replace(/[^a-z0-9_-]/gi, "_"), `${v}.json`);
function read(pid: string, v: Vendor): Stored { try { return JSON.parse(readFileSync(file(pid, v), "utf8")); } catch { return {}; } }
function write(pid: string, v: Vendor, s: Stored) { const f = file(pid, v); mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 }); }
const patch = (pid: string, v: Vendor, fn: (s: Stored) => void) => { const s = read(pid, v); fn(s); write(pid, v, s); };

class NeedsSignIn extends Error { constructor(public url: URL) { super("sign-in needed"); } }

/** OAuth client kept in that file. `interactive` hands back the sign-in page instead of failing. */
class Provider implements OAuthClientProvider {
  authUrl?: URL;
  constructor(private pid: string, private v: Vendor, private s: Stored, private redirect: string | undefined, private interactive: boolean) {}
  get redirectUrl() { return this.redirect ?? this.s.redirect ?? ""; }
  get clientMetadata(): OAuthClientMetadata {
    const scope = VENDORS[this.v].scope;
    return { client_name: "Recall", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) };
  }
  state() { return this.s.state ?? ""; }
  clientInformation() { return this.redirect && this.s.redirect !== this.redirect ? undefined : this.s.client; }
  saveClientInformation(c: OAuthClientInformationMixed) { this.s.client = c; this.s.redirect = this.redirectUrl; write(this.pid, this.v, this.s); }
  tokens() { return this.s.tokens; }
  saveTokens(t: OAuthTokens) { this.s.tokens = t; this.s.connected_at ??= new Date().toISOString(); write(this.pid, this.v, this.s); }
  redirectToAuthorization(u: URL) { this.authUrl = u; if (!this.interactive) throw new NeedsSignIn(u); }
  saveCodeVerifier(cv: string) { this.s.verifier = cv; write(this.pid, this.v, this.s); }
  codeVerifier() { if (!this.s.verifier) throw new Error("no sign-in in progress"); return this.s.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.s.client;
    if (scope === "all" || scope === "tokens") delete this.s.tokens;
    if (scope === "all" || scope === "verifier") delete this.s.verifier;
    write(this.pid, this.v, this.s);
  }
}

/** The vendor's sign-in page for this person; `redirect` is Recall's callback as their browser sees it. */
export async function startConnect(v: Vendor, person: Who, redirect: string): Promise<URL> {
  const s = read(person.id, v);
  s.state = `${person.id}.${randomBytes(16).toString("hex")}`;
  delete s.tokens; delete s.last_error;
  write(person.id, v, s);
  const p = new Provider(person.id, v, s, redirect, true);
  await auth(p, { serverUrl: VENDORS[v].url, scope: VENDORS[v].scope });
  if (!p.authUrl) throw new Error(`${VENDORS[v].name} didn't send a sign-in page`);
  return p.authUrl;
}

/** The person a returning sign-in belongs to: the state names them, and it must match what was stored. */
export const personOfState = (state: string) => state.split(".")[0] ?? "";

/** Back from the vendor with ?state&code. Only the sign-in that was started for this person can finish. */
export async function finishConnect(v: Vendor, person: Who, state: string, code: string): Promise<void> {
  const s = read(person.id, v);
  if (!s.state || s.state !== state || !state.startsWith(`${person.id}.`)) throw new Error(`This sign-in link is old. Tap Connect ${VENDORS[v].name} again.`);
  await auth(new Provider(person.id, v, s, undefined, false), { serverUrl: VENDORS[v].url, authorizationCode: code, scope: VENDORS[v].scope });
  delete s.state; delete s.verifier;
  s.seen ??= [];
  write(person.id, v, s);
}

/** Use a sign-in this person already gave another app on this server (the Soul Map's Otter, say). */
export function adopt(v: Vendor, pid: string, from: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirect?: string }) {
  if (read(pid, v).tokens || !from.tokens) return false;
  write(pid, v, { client: from.client, tokens: from.tokens, redirect: from.redirect, connected_at: new Date().toISOString(), seen: [] });
  return true;
}

export function status(v: Vendor, pid: string) {
  const s = read(pid, v);
  return { connected: !!s.tokens, connected_at: s.connected_at, last_sync: s.last_sync, saved: s.saved ?? 0, syncing: !!s.syncing, error: s.last_error };
}
export function disconnect(v: Vendor, pid: string) { rmSync(file(pid, v), { force: true }); }
export const connected = (v: Vendor, pid: string) => existsSync(file(pid, v)) && !!read(pid, v).tokens;

async function withClient<T>(v: Vendor, pid: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const s = read(pid, v);
  if (!s.tokens) throw new Error(`${VENDORS[v].name} isn't connected`);
  const client = new Client({ name: "recall", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(VENDORS[v].url), { authProvider: new Provider(pid, v, s, undefined, false) }));
    return await fn(client);
  } catch (e) {
    if (e instanceof NeedsSignIn || /unauthori[sz]ed|invalid_token|invalid_grant|401/i.test(String(e))) throw new Error(`${VENDORS[v].name} sign-in expired. Tap Connect ${VENDORS[v].name} again.`);
    throw e;
  } finally { await client.close().catch(() => {}); }
}
export { withClient as withVendor };

/** A tool's text, as JSON when it is JSON; Otter wraps its JSON in another text envelope, peeled here. */
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  let v: any = ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name}: ${String(v).slice(0, 200)}`);
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { return v; }
    const parts = v?.content ?? v?.result?.content;
    if (Array.isArray(parts) && parts.every((p: any) => p?.type === "text")) v = parts.map((p: any) => p.text ?? "").join("\n");
  }
  return v;
}

type Meeting = { id: string; title: string; date: string; attendees: string[]; summary?: string };
const unescape = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ── Granola ──────────────────────────────────────────────────────────────────
// list_meetings answers in tagged text: <meeting id="…" title="…" meeting_at="…"> with <known_participants>.
// get_meetings: the notes and AI summary, wrapped in guidance written for AI assistants (stripped).
// get_meeting_transcript: JSON {meetings:[{transcript, truncated, next_offset}]}, "Microphone" is the recorder.
async function granolaList(c: Client, since: Date | null): Promise<Meeting[]> {
  const out: Meeting[] = []; let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    const args: Record<string, unknown> = { limit: 200, time_range: "custom", from_date: HISTORY_FROM, to_date: ymd(new Date(Date.now() + 864e5)), ...(since ? { updated_after: since.toISOString() } : {}), ...(cursor ? { cursor } : {}) };
    const t = String(await call(c, "list_meetings", args));
    for (const m of t.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/gi)) {
      const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`, "i").exec(m[1])?.[1];
      const id = a("id"); if (!id) continue;
      const people = /<known_participants>([\s\S]*?)<\/known_participants>/i.exec(m[2])?.[1] ?? "";
      out.push({ id, title: unescape(a("title") ?? "Meeting"), date: a("meeting_at") ?? a("date") ?? "", attendees: people.split(",").map((x) => unescape(x.replace(/\([^)]*\)/g, "").trim())).filter(Boolean) });
    }
    cursor = /next_cursor="([^"]+)"/.exec(t)?.[1];
    if (!cursor || /has_more="false"/.test(t)) break;
  }
  return out;
}
async function granolaNotes(c: Client, id: string): Promise<string> {
  let t = String(await call(c, "get_meetings", { meeting_ids: [id] }).catch((e) => `(notes unavailable: ${String(e).slice(0, 120)})`));
  const i = t.indexOf("<meetings_data"); if (i >= 0) t = t.slice(i);
  t = t.replace(/<transcript\b[^>]*>[\s\S]*?<\/transcript>/gi, ""); // guidance for AI assistants, not the meeting
  return unescape(t.replace(/<\/?(meetings_data|meeting|known_participants|folders|private_notes|summary|notes?)\b[^>]*>/gi, "\n")).replace(/\n\s*\n(\s*\n)+/g, "\n\n").trim();
}
async function granolaTranscript(c: Client, id: string, me: string): Promise<string> {
  let out = "", offset = 0;
  for (let page = 0; page < 15; page++) {
    const r = await call(c, "get_meeting_transcript", { meeting_ids: [id], ...(offset ? { offset } : {}) }).catch(() => null);
    const m = r?.meetings?.[0]; const text = typeof m?.transcript === "string" ? m.transcript : "";
    if (!text) break;
    out += text;
    if (!m.truncated || !m.next_offset || m.next_offset <= offset) break;
    offset = m.next_offset;
  }
  return out.replace(/^Microphone:/gm, `${me}:`).replace(/^System audio \(([^)]+)\):/gm, "$1:").replace(/^System audio:/gm, "Others:").replace(/\n{2,}/g, "\n");
}

// ── Otter ────────────────────────────────────────────────────────────────────
// otter_search pages through conversations ({results, next_cursor}); otter_fetch gives the transcript text.
async function otterList(c: Client, since: Date | null): Promise<Meeting[]> {
  const out: Meeting[] = []; let cursor: string | undefined;
  const after = since ? `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}` : undefined;
  for (let page = 0; page < 200; page++) {
    const r = await call(c, "otter_search", { ...(after ? { created_after: after } : {}), page_size: 25, include_shared_meetings: true, ...(cursor ? { cursor } : {}) });
    for (const h of (r?.results ?? []) as any[]) {
      if (!h?.id || /^0s$/.test(String(h.duration ?? ""))) continue;
      out.push({ id: String(h.id), title: String(h.title ?? "Meeting"), date: String(h.start_time ?? ""), attendees: [], summary: h.short_summary });
    }
    cursor = r?.next_cursor; if (!cursor) break;
  }
  return out;
}
async function otterTranscript(c: Client, id: string): Promise<{ text: string; summary?: string }> {
  const m = await call(c, "otter_fetch", { id }).catch(() => null);
  return { text: typeof m?.text === "string" ? m.text : typeof m === "string" ? m : "", summary: m?.summary ?? m?.short_summary };
}

export type Saver = (person: Who, input: { notes: string; files: string[]; source: string }) => Promise<unknown>;

/** Fetch this person's new meetings from one vendor and save each one. Returns how many were saved. */
export async function syncPerson(v: Vendor, person: Who, save: Saver): Promise<number> {
  const s = read(person.id, v);
  if (!s.tokens) return 0;
  // One sync at a time per person and vendor (a first sync of hundreds of meetings takes a while).
  // A sync this process started is still running; one from before a restart is over and picks up where it stopped.
  if (s.syncing && Date.parse(s.syncing) >= BOOT) return 0;
  patch(person.id, v, (x) => { x.syncing = new Date().toISOString(); });
  const since = s.last_sync ? new Date(Date.parse(s.last_sync) - 2 * 864e5) : null;
  const seen = new Set(s.seen ?? []);
  let saved = 0;
  try {
    saved = await withClient(v, person.id, async (c) => {
      const listed = v === "granola" ? await granolaList(c, since) : await otterList(c, since);
      // The twin takes a handful per sync, so a test never pulls (and pays to sort) someone's whole history.
      const fresh = listed.filter((m) => !seen.has(m.id)).slice(0, TWIN ? 8 : Infinity);
      console.log(`[meetings] ${person.id} ${v}: ${fresh.length} new of ${listed.length} listed`);
      let n = 0;
      for (const m of fresh) {
        let notes = "", transcript = "";
        if (v === "granola") { notes = await granolaNotes(c, m.id); transcript = await granolaTranscript(c, m.id, person.name); }
        else { const t = await otterTranscript(c, m.id); notes = t.summary ?? m.summary ?? ""; transcript = t.text; }
        // An empty recording (a few words, no summary) is not worth a page.
        if (!notes.trim() && transcript.replace(/\[[^\]]*\]|Speaker[^:\n]{0,20}:|\s/g, "").length < 200) {
          seen.add(m.id); patch(person.id, v, (x) => { x.seen = [...seen]; }); continue;
        }
        const day = m.date ? (isNaN(Date.parse(m.date)) ? m.date : new Date(m.date).toISOString().slice(0, 10)) : "";
        const md = [`# ${m.title}`, [day && `Date: ${day}`, m.attendees.length && `With: ${m.attendees.join(", ")}`, `From ${VENDORS[v].name}`].filter(Boolean).join("  \n"),
          "", "## Notes", "", notes || "(no notes)", ...(transcript ? ["", "## Transcript", "", transcript] : [])].join("\n");
        const tmp = join(tmpdir(), `meeting-${person.id}-${v}-${m.id.replace(/[^\w-]/g, "_")}`); mkdirSync(tmp, { recursive: true });
        const path = join(tmp, `${`${day} ${m.title}`.trim().replace(/[/\\:*?"<>|]+/g, "-").slice(0, 90) || "Meeting"}.md`); writeFileSync(path, md);
        try { await save(person, { notes: `Meeting from ${VENDORS[v].name}: ${m.title}${day ? ` (${day})` : ""}.`, files: [path], source: `meeting:${v}` }); }
        finally { rmSync(tmp, { recursive: true, force: true }); }
        seen.add(m.id); n++;
        patch(person.id, v, (x) => { x.seen = [...seen]; x.saved = (x.saved ?? 0) + 1; }); // a crash mid-run never saves a meeting twice
      }
      return n;
    });
    patch(person.id, v, (x) => { x.last_sync = new Date().toISOString(); delete x.last_error; });
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 200);
    patch(person.id, v, (x) => { x.last_error = msg; });
    console.error(`[meetings] ${person.id} ${v}: ${msg}`);
  } finally { patch(person.id, v, (x) => { delete x.syncing; }); }
  return saved;
}
