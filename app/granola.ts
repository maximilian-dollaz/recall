// Granola: each person's meetings flow into their own library, on their own.
// Connect: GET /connect/granola sends the browser to Granola's sign-in (OAuth through Granola's MCP
// server, where Recall registers itself as a client); Granola sends it back to /connect/granola/callback.
// Sync: every half hour, each connected person's new meetings are fetched (the notes, and the transcript
// when their Granola plan includes it) and saved like any other save, one item per meeting, so the
// librarian files it into a project and pieces.ts pulls out its ideas and actions.
// Sign-ins live outside every library (never in git or GBrain): ~/.gbrain/serve/connectors/<person>/granola.json, mode 600.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DATA, TWIN } from "./paths.ts";

const SERVER = "https://mcp.granola.ai/mcp";
const DIR = Bun.env.RECALL_CONNECTORS ?? (TWIN ? join(DATA, "connectors") : join(Bun.env.HOME ?? "", ".gbrain/serve/connectors"));
/** The first sync after connecting goes back this far; later ones pick up from the last sync. */
const FIRST_DAYS = 30;

type Who = { id: string; name: string; email: string };
type Stored = { redirect?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string;
  connected_at?: string; last_sync?: string; last_error?: string; seen?: string[]; saved?: number };

const file = (pid: string) => join(DIR, pid.replace(/[^a-z0-9_-]/gi, "_"), "granola.json");
function read(pid: string): Stored { try { return JSON.parse(readFileSync(file(pid), "utf8")); } catch { return {}; } }
function write(pid: string, s: Stored) { const f = file(pid); mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 }); }

class NeedsSignIn extends Error { constructor(public url: URL) { super("sign-in needed"); } }

/** OAuth client kept in that file. `interactive` hands back the sign-in page instead of failing. */
class Provider implements OAuthClientProvider {
  authUrl?: URL;
  constructor(private pid: string, private s: Stored, private redirect: string | undefined, private interactive: boolean) {}
  get redirectUrl() { return this.redirect ?? this.s.redirect ?? ""; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Recall", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return this.s.state ?? ""; }
  clientInformation() { return this.redirect && this.s.redirect !== this.redirect ? undefined : this.s.client; }
  saveClientInformation(c: OAuthClientInformationMixed) { this.s.client = c; this.s.redirect = this.redirectUrl; write(this.pid, this.s); }
  tokens() { return this.s.tokens; }
  saveTokens(t: OAuthTokens) { this.s.tokens = t; this.s.connected_at ??= new Date().toISOString(); write(this.pid, this.s); }
  redirectToAuthorization(u: URL) { this.authUrl = u; if (!this.interactive) throw new NeedsSignIn(u); }
  saveCodeVerifier(v: string) { this.s.verifier = v; write(this.pid, this.s); }
  codeVerifier() { if (!this.s.verifier) throw new Error("no sign-in in progress"); return this.s.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.s.client;
    if (scope === "all" || scope === "tokens") delete this.s.tokens;
    if (scope === "all" || scope === "verifier") delete this.s.verifier;
    write(this.pid, this.s);
  }
}

/** Granola's sign-in page for this person; `redirect` is Recall's callback as their browser sees it. */
export async function startConnect(person: Who, redirect: string): Promise<URL> {
  const s = read(person.id);
  s.state = `${person.id}.${randomBytes(16).toString("hex")}`;
  delete s.tokens; delete s.last_error;
  write(person.id, s);
  const p = new Provider(person.id, s, redirect, true);
  await auth(p, { serverUrl: SERVER });
  if (!p.authUrl) throw new Error("Granola didn't send a sign-in page");
  return p.authUrl;
}

/** Back from Granola with ?state&code. Only the person who started the sign-in can finish it. */
export async function finishConnect(person: Who, state: string, code: string): Promise<void> {
  const s = read(person.id);
  if (!s.state || s.state !== state || !state.startsWith(`${person.id}.`)) throw new Error("This sign-in link is old. Tap Connect Granola again.");
  await auth(new Provider(person.id, s, undefined, false), { serverUrl: SERVER, authorizationCode: code });
  delete s.state; delete s.verifier;
  s.seen ??= [];
  write(person.id, s);
}

export function status(pid: string) {
  const s = read(pid);
  return { connected: !!s.tokens, connected_at: s.connected_at, last_sync: s.last_sync, saved: s.saved ?? 0, error: s.last_error };
}
export function disconnect(pid: string) { rmSync(file(pid), { force: true }); }
export function connectedIds(listIds: string[]) { return listIds.filter((id) => existsSync(file(id)) && !!read(id).tokens); }

async function withClient<T>(pid: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const s = read(pid);
  if (!s.tokens) throw new Error("Granola isn't connected");
  const client = new Client({ name: "recall", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: new Provider(pid, s, undefined, false) }));
    return await fn(client);
  } catch (e) {
    if (e instanceof NeedsSignIn || /unauthori[sz]ed|invalid_token|invalid_grant|401/i.test(String(e))) throw new Error("Granola sign-in expired. Tap Connect Granola again.");
    throw e;
  } finally { await client.close().catch(() => {}); }
}

/** A tool's text, as JSON when it is JSON. */
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

type Tool = { name: string; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } };
/** Arguments named the way this tool's schema names them (Granola's names have changed between versions). */
function argsFor(t: Tool, want: { ids?: string[]; id?: string; since?: Date }): Record<string, unknown> {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  const a: Record<string, unknown> = {};
  // One way of naming the meeting only: the first list of meeting ids, else the first single id.
  const idsKey = want.ids && props.find((k) => /^(meeting_ids|note_ids|document_ids|ids)$/i.test(k));
  const idKey = !idsKey && want.id && props.find((k) => /^(meeting_?id|id|document_?id|note_?id)$/i.test(k));
  if (idsKey) a[idsKey] = want.ids; else if (idKey) a[idKey] = want.id;
  for (const k of props) {
    if (k === idsKey || k === idKey) continue;
    else if (want.since && /^(since|after|from|start(_date|_time)?|created_after|updated_after)$/i.test(k)) a[k] = t.inputSchema!.properties![k].type === "string" && /date$/i.test(k) ? want.since.toISOString().slice(0, 10) : want.since.toISOString();
    else if (/^(limit|page_size|max_results)$/i.test(k)) a[k] = 100;
    else if (/^time_range$/i.test(k)) a[k] = "last_30_days";
  }
  return a;
}

type Meeting = { id: string; title: string; date: string; attendees: string[] };
/** Meetings in whatever shape Granola returns: objects with an id plus a title or a date, at any depth. */
function meetingsIn(listed: unknown): Meeting[] {
  const out = new Map<string, Meeting>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, any>;
    const id = r.id ?? r.meeting_id ?? r.document_id ?? r.note_id;
    if (typeof id === "string" && (r.title !== undefined || r.created_at !== undefined || r.date !== undefined || r.start_time !== undefined)) {
      const people = (r.attendees ?? r.participants ?? r.people ?? []) as any[];
      out.set(id, { id, title: String(r.title ?? r.name ?? "Meeting"), date: String(r.date ?? r.start_time ?? r.created_at ?? ""),
        attendees: Array.isArray(people) ? people.map((p) => (typeof p === "string" ? p : p?.name ?? p?.email ?? "")).filter(Boolean) : [] });
    } else Object.values(r).forEach(walk);
  };
  walk(listed);
  if (typeof listed === "string") {
    // Text listings: one meeting per block that names an id.
    for (const m of listed.matchAll(/<meeting[^>]*\bid=["']?([\w-]{8,})["']?[^>]*>/gi)) {
      const title = (/title="([^"]+)"/i.exec(m[0])?.[1] ?? "Meeting").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      const date = /meeting_at="([^"]+)"/i.exec(m[0])?.[1] ?? /\bdate="([^"]+)"/i.exec(m[0])?.[1] ?? "";
      out.set(m[1], { id: m[1], title, date, attendees: [] });
    }
    if (!out.size) for (const m of listed.matchAll(/\b(?:id|meeting_id)["']?\s*[:=]\s*["']?([\w-]{8,})/g)) out.set(m[1], { id: m[1], title: "Meeting", date: "", attendees: [] });
  }
  return [...out.values()];
}
const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));

/** Granola wraps the notes in guidance written for AI assistants; keep only the meeting itself, as plain text. */
function cleanNotes(v: unknown): string {
  let t = asText(v);
  const i = t.indexOf("<meetings_data"); if (i >= 0) t = t.slice(i);
  t = t.replace(/<transcript\b[^>]*>[\s\S]*?<\/transcript>/gi, ""); // guidance for AI assistants, not the meeting
  return t.replace(/<\/?(meetings_data|meeting|known_participants|folders|private_notes|summary|notes?)\b[^>]*>/gi, "\n").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}

/** The whole transcript, page by page (Granola sends about 40,000 characters at a time), as "Name: words" lines.
 *  "Microphone" is the person who recorded it, so it carries their name. */
async function fullTranscript(c: Client, t: Tool, id: string, me: string): Promise<string> {
  let out = "", offset = 0;
  for (let page = 0; page < 15; page++) {
    const r = await call(c, t.name, { ...argsFor(t, { ids: [id], id }), ...(offset ? { offset } : {}) }).catch(() => null) as any;
    const m = r?.meetings?.[0] ?? r; const text = typeof m?.transcript === "string" ? m.transcript : typeof r === "string" ? r : "";
    if (!text) break;
    out += text;
    if (!m?.truncated || !m?.next_offset || m.next_offset <= offset) break;
    offset = m.next_offset;
  }
  return out.replace(/^Microphone:/gm, `${me}:`).replace(/^System audio \(([^)]+)\):/gm, "$1:").replace(/^System audio:/gm, "Others:").replace(/\n{2,}/g, "\n");
}

export type Saver = (person: Who, input: { notes: string; files: string[] }) => Promise<unknown>;

/** Fetch this person's new meetings and save each one. Returns how many were saved. */
export async function syncPerson(person: Who, save: Saver): Promise<number> {
  const s = read(person.id);
  if (!s.tokens) return 0;
  const since = s.last_sync ? new Date(new Date(s.last_sync).getTime() - 2 * 864e5) : new Date(Date.now() - FIRST_DAYS * 864e5);
  const seen = new Set(s.seen ?? []);
  let saved = 0;
  try {
    saved = await withClient(person.id, async (c) => {
      const tools = (await c.listTools()).tools as Tool[];
      const lister = tools.find((t) => /^list_meetings$/i.test(t.name)) ?? tools.find((t) => /list_(meetings|documents|notes)|search_meetings/i.test(t.name));
      const notesGetter = tools.find((t) => /^get_meetings?$/i.test(t.name)) ?? tools.find((t) => /get_(meeting|document|note)s?$/i.test(t.name) && !/transcript/i.test(t.name));
      const transcriptGetter = tools.find((t) => /transcript/i.test(t.name));
      if (!lister) throw new Error(`Granola's tools weren't recognised (${tools.map((t) => t.name).join(", ")})`);
      // Every page of the list (Granola caps a page at 100 to 200 meetings and hands back a cursor).
      const all: Meeting[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const listed = await call(c, lister.name, { ...argsFor(lister, { since }), ...(cursor ? { cursor } : {}) });
        all.push(...meetingsIn(listed));
        cursor = typeof listed === "string" ? /next_cursor="([^"]+)"/.exec(listed)?.[1] : (listed as any)?.next_cursor;
        if (!cursor || (typeof listed === "string" && /has_more="false"/.test(listed))) break;
      }
      const meetings = all.filter((m) => !seen.has(m.id));
      console.log(`[granola] ${person.id}: ${meetings.length} new of ${all.length} listed`);
      let n = 0;
      for (const m of meetings) {
        const notes = notesGetter ? cleanNotes(await call(c, notesGetter.name, argsFor(notesGetter, { ids: [m.id], id: m.id })).catch((e) => `(notes unavailable: ${String(e).slice(0, 120)})`)) : "";
        // Transcripts come with paid Granola plans; without one the notes are saved on their own.
        const transcript = transcriptGetter ? await fullTranscript(c, transcriptGetter, m.id, person.name) : "";
        const md = [`# ${m.title}`, [m.date && `Date: ${m.date}`, m.attendees.length && `With: ${m.attendees.join(", ")}`, "From Granola"].filter(Boolean).join("  \n"),
          "", "## Notes", "", asText(notes) || "(no notes)", ...(transcript ? ["", "## Transcript", "", asText(transcript)] : [])].join("\n");
        const tmp = join(tmpdir(), `granola-${person.id}-${m.id.replace(/[^\w-]/g, "_")}`); mkdirSync(tmp, { recursive: true });
        const name = `${(m.date || "").slice(0, 10)} ${m.title}`.trim().replace(/[/\\:*?"<>|]+/g, "-").slice(0, 90) || "Meeting";
        const path = join(tmp, `${name}.md`); writeFileSync(path, md);
        try { await save(person, { notes: `Meeting notes from Granola: ${m.title}${m.date ? ` (${m.date.slice(0, 10)})` : ""}.`, files: [path] }); }
        finally { rmSync(tmp, { recursive: true, force: true }); }
        seen.add(m.id); n++;
        const cur = read(person.id); cur.seen = [...seen]; cur.saved = (cur.saved ?? 0) + 1; write(person.id, cur); // a crash mid-run never saves a meeting twice
      }
      return n;
    });
    const cur = read(person.id); cur.last_sync = new Date().toISOString(); delete cur.last_error; write(person.id, cur);
  } catch (e) {
    const cur = read(person.id); cur.last_error = String((e as Error).message ?? e).slice(0, 200); write(person.id, cur);
    console.error(`[granola] ${person.id}: ${cur.last_error}`);
  }
  return saved;
}
export { withClient as withGranola };
