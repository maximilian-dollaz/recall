// Deepgram speech-to-text: live words on the Save page (the browser streams its voice to Recall, and Recall
// streams it on to Deepgram with the key, so the key never leaves this Mac) and recorded notes from the shortcuts.
// On only when Max has pasted a key on the Keys page. Until he OKs the privacy line, only Max's own voice
// goes to Deepgram (library/settings.json {"deepgramForTeam": true} opens it to everyone); everyone else keeps
// the speech they have today. Any Deepgram failure falls back to transcribing on this Mac.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA as ROOT } from "./paths.ts";

const KEY = join(Bun.env.HOME ?? "", ".gbrain/serve/deepgram.key");
const API = "https://api.deepgram.com/v1";
// nova-3: Deepgram's most accurate English model; smart_format adds punctuation and capitals.
const PARAMS = "model=nova-3&language=en&smart_format=true";

const key = () => { try { return readFileSync(KEY, "utf8").trim(); } catch { return ""; } };
export const hasKey = () => existsSync(KEY) && key().length >= 20;
const forTeam = () => { try { return !!JSON.parse(readFileSync(join(ROOT, "library/settings.json"), "utf8")).deepgramForTeam; } catch { return false; } };
/** Whether this person's voice goes to Deepgram. */
export const allowed = (isOwner: boolean) => hasKey() && (isOwner || forTeam());

// The live relay: the page opens a WebSocket to /api/listen/ws?rate=<sample rate> and sends 16-bit PCM;
// everything Deepgram sends back goes straight to the page. Mounted on the gate and the public door.
export const LISTEN_PATH = "/api/listen/ws";
type Relay = { rate: number; up?: WebSocket; queue: (ArrayBuffer | string)[] };
export const relay = {
  open(ws: import("bun").ServerWebSocket<Relay>) {
    const up = new WebSocket(`wss://api.deepgram.com/v1/listen?${PARAMS}&interim_results=true&endpointing=300&encoding=linear16&channels=1&sample_rate=${ws.data.rate}`, { headers: { Authorization: `Token ${key()}` } } as any);
    up.binaryType = "arraybuffer";
    ws.data.up = up;
    up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
    up.onmessage = (m) => { try { ws.send(m.data as string); } catch {} };
    up.onclose = (e) => { if (e.code !== 1000) console.error(`[deepgram] live stream closed ${e.code} ${e.reason}`.slice(0, 200)); try { ws.close(); } catch {} };
    up.onerror = () => console.error("[deepgram] live stream error");
  },
  message(ws: import("bun").ServerWebSocket<Relay>, m: string | Buffer) {
    const up = ws.data.up, data = typeof m === "string" ? m : (m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);
    if (up?.readyState === 1) up.send(data); else ws.data.queue.push(data);
  },
  close(ws: import("bun").ServerWebSocket<Relay>) {
    const up = ws.data.up; if (!up) return;
    try { if (up.readyState === 1) up.send(JSON.stringify({ type: "CloseStream" })); } catch {}
    setTimeout(() => { try { up.close(); } catch {} }, 3000);
  },
};
/** Upgrade the request to the live relay when this person's voice goes to Deepgram. */
export function upgrade(req: Request, srv: import("bun").Server, isOwner: boolean): Response | undefined {
  if (!allowed(isOwner)) return new Response("off", { status: 403 });
  const rate = Math.min(96000, Math.max(8000, Number(new URL(req.url).searchParams.get("rate")) || 48000));
  return srv.upgrade(req, { data: { rate, queue: [] } }) ? undefined : new Response("expected a websocket", { status: 400 });
}

/** A recorded note (any audio file) → text. Throws when Deepgram can't, so the caller can fall back. */
export async function transcribe(path: string): Promise<string> {
  const f = Bun.file(path);
  const r = await fetch(`${API}/listen?${PARAMS}`, { method: "POST", headers: { Authorization: `Token ${key()}`, "content-type": f.type || "audio/mp4" }, body: f, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d: any = await r.json();
  return String(d?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").replace(/\s+/g, " ").trim();
}

/** Deepgram first, this Mac's own transcriber if Deepgram is off or fails. */
export async function transcribeAny(path: string, useDeepgram: boolean): Promise<string> {
  if (useDeepgram) {
    const t0 = Date.now();
    try { const t = await transcribe(path); console.log(`[deepgram] ${t.length} chars in ${Date.now() - t0} ms`); return t; }
    catch (e) { console.error(`[deepgram] ${String(e).slice(0, 200)}; transcribing on this Mac instead`); }
  }
  return (await import("./extract.ts")).transcribe(path);
}
