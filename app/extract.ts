// Turn whatever was attached into searchable text: documents, web pages, images, video.
// Images and video frames go through the librarian's vision model.

import { extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { describeImage } from "./librarian.ts";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp"]);
const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const AUDIO = new Set([".caf", ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".aiff"]);

// Filing runs one save at a time for everyone, so nothing it waits on may wait forever.
const PAGE_MS = 20_000;                 // a web page: connect, redirects and the whole body
const PAGE_MAX = 5 * 1024 ** 2;         // read at most 5 MB of a page; more would stall the parser too
const TOOL_MS = 2 * 60_000;             // sips, pdftotext, ffprobe, OCR: seconds normally
const LONG_MS = 10 * 60_000;            // ffmpeg and Whisper on a long voice note or video

/** Start a tool and kill it if it runs past `ms` (its exit code is then non-zero, which callers already handle). */
function spawn(cmd: string[], ms: number, opts: { stdin?: Blob } = {}) {
  const p = Bun.spawn(cmd, { stdin: opts.stdin, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { console.error(`[extract] ${basename(cmd[0])} ran over ${ms / 1000}s, stopped`); p.kill(9); }, ms);
  p.exited.finally(() => clearTimeout(timer));
  return p;
}

/** Voice notes: transcribed on this Mac with mlx-whisper (Apple-silicon Whisper; nothing leaves the machine). */
export async function transcribe(path: string): Promise<string> {
  const ROOT = join(import.meta.dir, "..");
  const bin = join(ROOT, "tools/.venv/bin/mlx_whisper");
  const model = process.env.WHISPER_MODEL ?? "mlx-community/whisper-base.en-mlx";
  const stamp = `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const wav = join(tmpdir(), `${stamp}.wav`);
  const conv = spawn(["ffmpeg", "-v", "error", "-y", "-i", path, "-ar", "16000", "-ac", "1", wav], LONG_MS);
  const convErr = await new Response(conv.stderr).text();
  if ((await conv.exited) !== 0) { console.error(`[transcribe] ffmpeg failed on ${path}: ${convErr.slice(-400)}`); throw new Error("could not convert audio: " + convErr.trim().split("\n").pop()?.slice(0, 160)); }
  const p = spawn([bin, wav, "--model", model, "--output-dir", tmpdir(), "--output-format", "txt", "--verbose", "False"], LONG_MS);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const txtPath = join(tmpdir(), `${stamp}.txt`);
  let text = "";
  try { text = await Bun.file(txtPath).text(); unlinkSync(txtPath); } catch {}
  try { unlinkSync(wav); } catch {}
  if (code !== 0) { console.error(`[transcribe] mlx_whisper exit ${code}: ${(err || out).slice(-600)}`); throw new Error("transcription failed: " + (err || out).trim().split("\n").pop()?.slice(0, 160)); }
  if (!text.trim()) { console.error(`[transcribe] empty transcript for ${path}`); return ""; }
  return text.replace(/\s+/g, " ").trim();
}

export type Extracted = { text: string; kind: "document" | "image" | "video" | "link" | "other"; title?: string; description?: string };

async function run(cmd: string[], stdin?: Uint8Array, ms = TOOL_MS): Promise<{ out: string; code: number }> {
  const p = spawn(cmd, ms, { stdin: stdin ? new Blob([stdin]) : undefined });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); // drain stderr so a chatty tool can't block
  return { out, code: await p.exited };
}

async function sips(path: string): Promise<string> {
  // Downscale for the vision model and convert HEIC → JPEG. macOS ships `sips`.
  const outPath = join(tmpdir(), `cl-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  await run(["sips", "-s", "format", "jpeg", "-Z", "1280", path, "--out", outPath]);
  const b64 = Buffer.from(await Bun.file(outPath).arrayBuffer()).toString("base64");
  try { unlinkSync(outPath); } catch {}
  return b64;
}

/** The date a photo was taken (EXIF), which can be weeks before the day it was saved. */
export async function photoDate(path: string): Promise<string | undefined> {
  const r = await run(["mdls", "-name", "kMDItemContentCreationDate", "-raw", path]);
  const m = r.out.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const s = await run(["sips", "-g", "creation", path]);
  const m2 = s.out.match(/creation: (\d{4}):(\d{2}):(\d{2})/);
  return m2 ? `${m2[1]}-${m2[2]}-${m2[3]}` : undefined;
}

export async function extractFile(path: string, notes: string): Promise<Extracted & { taken?: string }> {
  const ext = extname(path).toLowerCase();
  if (IMAGE.has(ext)) {
    // Three passes: exact text (Apple Vision OCR, on device), what it looks like (vision model), when it was taken.
    const jpg = await sips(path);
    const ocrBin = join(import.meta.dir, "..", "tools/ocr");
    const [ocr, description, taken] = await Promise.all([
      run([ocrBin, path]).then((r) => (r.code === 0 ? r.out.trim() : "")).catch(() => ""),
      describeImage(jpg, notes),
      photoDate(path),
    ]);
    const words = ocr.split(/\s+/).filter(Boolean).length;
    const text = words >= 25 ? `${description}\n\nText in the picture (read exactly):\n\n${ocr}` : description;
    return { kind: "image", text, description, taken };
  }
  if (AUDIO.has(ext)) {
    const text = await transcribe(path);
    return { kind: "audio" as any, text: `Voice note transcript:\n\n${text}` };
  }
  if (VIDEO.has(ext)) {
    // Three frames spread across the video, each described; good enough to find it again.
    const descriptions: string[] = [];
    const probe = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
    const dur = Math.max(1, parseFloat(probe.out) || 1);
    for (const t of [0.1, 0.5, 0.9]) {
      const frame = join(tmpdir(), `cl-frame-${Date.now()}-${t}.jpg`);
      const r = await run(["ffmpeg", "-v", "error", "-y", "-ss", String(dur * t), "-i", path, "-frames:v", "1", "-vf", "scale=1280:-1", frame], undefined, LONG_MS);
      if (r.code === 0) descriptions.push(`[${Math.round(dur * t)}s] ` + (await describeImage(await sips(frame), notes)));
    }
    // What was said while filming: often the reason it was captured.
    const said = await transcribe(path).catch(() => "");
    const text = descriptions.join("\n\n") + (said.trim() ? `\n\nWhat was said in the video:\n\n${said.trim()}` : "");
    return { kind: "video", text, description: text };
  }
  switch (ext) {
    case ".docx": {
      const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(await Bun.file(path).arrayBuffer()) },
        { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) });
      return { kind: "document", text: td.turndown(value).replace(/!\[[^\]]*\]\(\)/g, "") };
    }
    case ".pdf": {
      const bin = Bun.which("pdftotext") ?? "/opt/homebrew/bin/pdftotext";
      const r = await run([bin, "-layout", path, "-"]);
      return { kind: "document", text: r.out };
    }
    case ".html": case ".htm": {
      const dom = new JSDOM(await Bun.file(path).text());
      const a = new Readability(dom.window.document).parse();
      return { kind: "document", text: td.turndown(a?.content ?? dom.serialize()), title: a?.title ?? undefined };
    }
    case ".md": case ".markdown": case ".txt": case ".csv": case ".json":
      return { kind: "document", text: await Bun.file(path).text() };
    default:
      return { kind: "other", text: "" };
  }
}

/** Only addresses on the internet: never this Mac, the home network or the tailnet (where the app itself listens). */
async function isPublic(u: URL): Promise<boolean> {
  if (!/^https?:$/.test(u.protocol)) return false;
  try {
    const { address } = await lookup(u.hostname.replace(/^\[|\]$/g, ""));
    return !(/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) || /^(::1|::|f[cd]|fe80|::ffff:)/i.test(address));
  } catch { return false; }
}

/** Read at most `max` bytes of a body, then hang up. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader(); if (!reader) return "";
  const parts: Uint8Array[] = []; let n = 0;
  while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.byteLength; }
  if (n >= max) reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, max));
}

export async function extractUrl(url: string): Promise<Extracted> {
  // One deadline for everything (each redirect, every byte), so a site that answers slowly can't hold up filing.
  const signal = AbortSignal.timeout(PAGE_MS);
  let u = new URL(url), res: Response | undefined;
  // Redirects are followed by hand so each hop is checked: a public page can't bounce us to the app on this Mac.
  for (let hop = 0; hop < 5 && !res; hop++) {
    if (!(await isPublic(u))) throw new Error(`not a public web address: ${u.host}`);
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) context-library/0.2" }, redirect: "manual", signal });
    const to = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (to) { r.body?.cancel().catch(() => {}); u = new URL(to, u); } else res = r;
  }
  if (!res) throw new Error(`too many redirects: ${url}`);
  // A link straight to a picture, video or file has no page text; don't feed its bytes to the HTML parser.
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/|html|xml/i.test(type)) { res.body?.cancel().catch(() => {}); return { kind: "link", text: "", title: url }; }
  const html = await readCapped(res, PAGE_MAX);
  const dom = new JSDOM(html, { url: u.toString() });
  const a = new Readability(dom.window.document).parse();
  const title = (a?.title || dom.window.document.title || url).trim();
  const text = a?.content ? td.turndown(a.content) : td.turndown(html);
  return { kind: "link", text, title };
}

export function stripSecrets(s: string): string {
  return s
    .replace(/\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/g, "[redacted key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[redacted token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(password|passwd|pwd)(\s*[:=]\s*)\S{4,}/gi, "$1$2[redacted]");
}

export function nameFor(path: string) { return basename(path, extname(path)); }
