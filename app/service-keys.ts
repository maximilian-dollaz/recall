// Service keys (OpenAI, Higgsfield, Deepgram, Resend): pasted into a box once on the Keys page, saved on this Mac with owner-only
// file permissions, never shown again, never logged. The app's /settings page and `cl keys` both use this.
// One step for Max: the page opens with the right box ready (?key=deepgram), and pasting saves it at once,
// checks it with the service where that's free, and empties the clipboard. A chat that opened the page can
// watch /status (saved or not, never the key) to know when it's done.

import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(Bun.env.HOME ?? "", ".gbrain/serve");
type Check = (k: string) => Promise<boolean>;
const KEYS: Record<string, { label: string; file: string; fields: string[]; join: (v: string[]) => string; ok: (k: string) => boolean; check?: Check }> = {
  higgsfield: { label: "Higgsfield", file: "higgsfield.key", fields: ["Key ID", "Secret"], join: (v) => v.length > 1 ? `${v[0]}:${v[1]}` : v[0].replace(/\s+/g, ":"), ok: (k) => k.length >= 20 && k.includes(":") },
  openai: { label: "OpenAI", file: "openai.key", fields: ["API key"], join: (v) => v[0], ok: (k) => k.startsWith("sk-") && k.length >= 20,
    check: async (k) => (await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) }).catch(() => null))?.status === 200 },
  deepgram: { label: "Deepgram", file: "deepgram.key", fields: ["API key"], join: (v) => v[0], ok: (k) => k.length >= 20,
    check: async (k) => (await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${k}` }, signal: AbortSignal.timeout(8000) }).catch(() => null))?.status === 200 },
  // Resend sends the Dream board invites. A sending-only key can't be checked for free, so it's only shape-checked.
  resend: { label: "Resend", file: "resend.key", fields: ["API key"], join: (v) => v[0], ok: (k) => k.startsWith("re_") && k.length >= 20 },
};
const json = (d: unknown, status = 200) => Response.json(d, { status });

/** Which keys are saved, and when: never the keys themselves. */
export function keyStatus() {
  return Object.fromEntries(Object.entries(KEYS).map(([id, k]) => { const f = join(DIR, k.file); return [id, existsSync(f) ? { saved: true, at: new Date(statSync(f).mtimeMs).toISOString() } : { saved: false }]; }));
}

export function keysPage(focus = ""): Response {
  const order = Object.entries(KEYS).sort(([a], [b]) => Number(b === focus) - Number(a === focus)); // the asked-for key first
  const rows = order.map(([id, k]) => {
    const f = join(DIR, k.file); const when = existsSync(f) ? new Date(statSync(f).mtimeMs).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
    const first = id === focus || (!focus && id === order[0][0]);
    return `<form data-key="${id}"${id === focus ? ' class="focus"' : ""}><h2>${k.label}</h2><p class="st">${when ? `Saved ${when}` : "Not set"}</p>${k.fields.map((n, i) => `<input name="v${i}" type="password" autocomplete="off" spellcheck="false" placeholder="${n}" aria-label="${k.label} ${n}"${first && i === 0 ? " autofocus" : ""}>`).join("")}<button>Save</button><p class="msg"></p></form>`;
  }).join("");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recall · Keys</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;font:16px/1.5 -apple-system,system-ui,sans-serif;color:#f3eee6;background:radial-gradient(120% 80% at 70% 20%,#5b4636,#1d1a17 60%);display:grid;place-items:center;padding:34px 16px;box-sizing:border-box}
main{width:min(460px,100%);display:grid;gap:21px}h1{margin:0;font-size:1.6rem}.lead{margin:0;color:#c9c1b6}
form{display:grid;gap:8px;padding:21px;border-radius:16px;background:rgba(36,31,27,.6);border:1px solid rgba(255,255,255,.14)}
h2{margin:0;font-size:1.1rem}.st{margin:0;color:#c9c1b6;font-size:.88rem}input{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.3);color:#f3eee6}
input:focus{outline:none;border-color:#e8a95c}form.focus{border-color:#e8a95c;box-shadow:0 0 34px rgba(232,169,92,.25)}button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:12px;background:#e8a95c;color:#1d1a17;cursor:pointer}.msg{margin:0;min-height:1.2em;font-size:.9rem;color:#e8a95c}</style>
<main><h1>Keys</h1><p class="lead">Paste a key and press Save. It stays on this Mac and is never shown again.</p>${rows}</main>
<script>document.querySelectorAll('form').forEach(f=>{f.addEventListener('paste',()=>setTimeout(()=>f.requestSubmit(),0));f.onsubmit=async(e)=>{e.preventDefault();const v=[...f.querySelectorAll('input')].map(i=>i.value.trim());const m=f.querySelector('.msg');
const r=await fetch(location.pathname.replace(/\\/?$/,'').replace(/\\/settings$/,'')+'/api/settings/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.dataset.key,values:v})});const d=await r.json().catch(()=>({}));
if(d.ok){f.querySelectorAll('input').forEach(i=>i.value='');m.textContent=d.message||'Saved.';f.querySelector('.st').textContent='Saved just now';}else m.textContent=d.error||'Not saved.';};});</script>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function saveServiceKey(b: any, who: string): Promise<Response> {
  const k = KEYS[String(b?.name)]; if (!k) return json({ error: "Unknown key." }, 400);
  const vals = (Array.isArray(b.values) ? b.values : []).map((v: unknown) => String(v ?? "").trim()).filter(Boolean);
  if (!vals.length) return json({ error: "Paste the key first." }, 400);
  const key = k.join(vals);
  if (!k.ok(key)) return json({ error: k.fields.length > 1 ? `That doesn't look like a ${k.label} key. Paste both the ${k.fields.join(" and the ")}.` : `That doesn't look like a ${k.label} key.` }, 400);
  if (k.check && !(await k.check(key))) return json({ error: `${k.label} didn't accept that key. Copy it again in ${k.label} and paste it here.` }, 400);
  mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, k.file), key, { mode: 0o600 });
  console.log(`[keys] ${k.label} key saved by ${who}`); // never the key itself
  // The key is in the clipboard until now; empty it (this page runs on the Mac it was pasted on).
  try { Bun.spawnSync(["pbcopy"], { stdin: new Blob([""]) }); } catch {}
  return json({ ok: true, message: k.check ? `Saved, and ${k.label} accepted it.` : "Saved." });
}

// `bun app/service-keys.ts`: the Keys page on its own, on this Mac only (127.0.0.1:3399), without the app.
if (import.meta.main) {
  Bun.serve({ port: 3399, hostname: "127.0.0.1", fetch: async (req) => {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/api/settings/key") return saveServiceKey(await req.json().catch(() => ({})), "this Mac");
    if (u.pathname === "/status") return json(keyStatus());
    return u.pathname === "/" ? keysPage(u.searchParams.get("key") ?? "") : new Response("not found", { status: 404 });
  } });
  console.log("Keys page: http://127.0.0.1:3399/");
}
