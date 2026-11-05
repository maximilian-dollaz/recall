// What Recall saves from a page: plain helpers shared by the pop-up, the background worker and the tests
// (tests/capture.test.ts). Pure functions first; the two at the end that run inside a web page
// (readDriveSelection, pictureBytes) are passed to chrome.scripting, so they use nothing from outside.

// Google files are read with the person's own Google sign-in, only after they allow it once.
// Docs and Drive answer exports and downloads from these hosts (the last three after a redirect).
const GOOGLE_ORIGINS = ["https://docs.google.com/*", "https://drive.google.com/*", "https://drive.usercontent.google.com/*", "https://*.googleusercontent.com/*", "https://lh3.google.com/*"];
const MAX_FILE = 15 * 1024 * 1024; // the save form has to carry it; bigger files are saved as a link

// ── Pictures ────────────────────────────────────────────────────────────────
// Pinterest shows small copies (236x, 474x, 564x, 736x); the same path under /originals/ is the full picture.
function pinterestOriginal(src) {
  return String(src || "").replace(/^(https:\/\/i\.pinimg\.com)\/(?:236x|474x|564x|736x|1200x)\//, "$1/originals/");
}
// Some pins have no original (or a different file type there); 736x always exists.
function pinterestFallback(src) {
  return String(src || "").replace(/^(https:\/\/i\.pinimg\.com)\/originals\//, "$1/736x/");
}
const isPinterest = (src) => /^https:\/\/i\.pinimg\.com\//.test(String(src || ""));

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/avif": "avif", "image/svg+xml": "svg", "application/pdf": "pdf", "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "video/mp4": "mp4", "video/quicktime": "mov" };
const extFor = (type) => EXT[String(type || "").split(";")[0].trim().toLowerCase()] || "bin";
// Drive often answers "application/octet-stream"; the file's own name says what it is.
function typeFor(name, given) {
  const t = String(given || "").split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream" && t !== "binary/octet-stream") return t;
  const ext = (String(name || "").match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
  const byExt = Object.entries(EXT).find(([, e]) => e === (ext === "jpeg" ? "jpg" : ext));
  return byExt ? byExt[0] : t || "application/octet-stream";
}

// A picture read inside the page comes back as a data: URL; the save form wants a Blob.
function dataUrlToBlob(data) {
  const m = String(data || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s); if (!m) return null;
  const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] || "application/octet-stream" });
}
// Files cross from the background worker to the pop-up as text, so bytes travel as base64.
function bytesToBase64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

// ── Google Drive and Docs ───────────────────────────────────────────────────
// Max is signed in to several Google accounts: /u/1/ or authuser=1 says which one this page belongs to.
function authuserOf(raw) {
  let u; try { u = new URL(raw); } catch { return ""; }
  return u.searchParams.get("authuser") || (u.pathname.match(/\/u\/(\d+)(?:\/|$)/) || [])[1] || "";
}
function withAuthuser(url, au) { return au && au !== "0" ? `${url}${url.includes("?") ? "&" : "?"}authuser=${au}` : url; }

const DOC_KINDS = { document: "doc", spreadsheets: "sheet", presentation: "slides" };
// A Google file named by its address: { id, kind, authuser }, or null for anything else.
function googleFromUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  const authuser = authuserOf(raw);
  if (u.hostname === "docs.google.com") {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([\w-]{15,})/);
    if (m) return { id: m[2], kind: DOC_KINDS[m[1]], authuser };
    return null;
  }
  if (u.hostname === "drive.google.com") {
    const f = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]{15,})/); if (f) return { id: f[1], kind: "", authuser };
    const d = u.pathname.match(/\/folders\/([\w-]{15,})/); if (d) return { id: d[1], kind: "folder", authuser };
    const id = u.searchParams.get("id"); if (id && /^\/(open|uc)\b/.test(u.pathname) && /^[\w-]{15,}$/.test(id)) return { id, kind: "", authuser };
  }
  return null;
}

// What a Drive item is, from its type icon (…/type/application/vnd.google-apps.document) or its label.
function kindFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.endsWith("vnd.google-apps.document")) return "doc";
  if (m.endsWith("vnd.google-apps.spreadsheet")) return "sheet";
  if (m.endsWith("vnd.google-apps.presentation")) return "slides";
  if (m.endsWith("vnd.google-apps.folder")) return "folder";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return m ? "file" : "";
}
function kindFromLabel(label) {
  const l = String(label || "");
  if (/\bGoogle Docs\b/i.test(l)) return "doc";
  if (/\bGoogle Sheets\b/i.test(l)) return "sheet";
  if (/\bGoogle Slides\b/i.test(l)) return "slides";
  if (/\.(jpe?g|png|gif|webp|heic|avif|tiff?)\b/i.test(l)) return "image";
  if (/\.(mp4|mov|m4v|webm)\b/i.test(l)) return "video";
  if (/\bfolder$/i.test(l.trim())) return "folder";
  return "";
}

// The address to keep for a Drive item: the editor for Google files, Drive's viewer for everything else.
function driveItemUrl(g) {
  const base = { doc: `https://docs.google.com/document/d/${g.id}/edit`, sheet: `https://docs.google.com/spreadsheets/d/${g.id}/edit`, slides: `https://docs.google.com/presentation/d/${g.id}/edit`, folder: `https://drive.google.com/drive/folders/${g.id}` }[g.kind] || `https://drive.google.com/file/d/${g.id}/view`;
  return withAuthuser(base, g.authuser);
}
// Where a Google file's words come from, best first: Docs as Markdown (plain text if that fails), Sheets as CSV, Slides as text.
function exportUrls(g) {
  const d = `https://docs.google.com`;
  const list = {
    doc: [[`${d}/document/d/${g.id}/export?format=md`, "md", "text/markdown"], [`${d}/document/d/${g.id}/export?format=txt`, "txt", "text/plain"]],
    sheet: [[`${d}/spreadsheets/d/${g.id}/export?format=csv`, "csv", "text/csv"]],
    slides: [[`${d}/presentation/d/${g.id}/export?format=txt`, "txt", "text/plain"], [`${d}/presentation/d/${g.id}/export/txt`, "txt", "text/plain"]],
  }[g.kind] || [];
  return list.map(([url, ext, type]) => ({ url: withAuthuser(url, g.authuser), ext, type }));
}
const downloadUrl = (g) => withAuthuser(`https://drive.google.com/uc?export=download&id=${g.id}`, g.authuser);
const thumbnailUrl = (g) => withAuthuser(`https://drive.google.com/thumbnail?id=${g.id}&sz=w1600`, g.authuser);

// "Room plan - Google Docs" → "Room plan".
function cleanTitle(t) { return String(t || "").replace(/\s+[-–]\s+Google (Docs|Sheets|Slides|Drive|Drawings|Forms)\s*$/i, "").trim(); }
// A name that is safe as a file name, with the right extension once.
function safeFileName(name, ext) {
  let n = String(name || "").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "file";
  if (ext && !n.toLowerCase().endsWith(`.${ext}`)) n += `.${ext}`;
  return n;
}

// What readDriveSelection found on the page, tidied into Google items. The page's /u/N/ goes with each one.
function driveItemsFrom(raw, pageUrl) {
  const authuser = authuserOf(pageUrl), seen = new Set();
  return (Array.isArray(raw) ? raw : []).filter((r) => r && /^[\w-]{15,}$/.test(r.id) && !seen.has(r.id) && seen.add(r.id)).map((r) => {
    const name = String(r.name || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
    return { id: r.id, kind: kindFromMime(r.mime) || kindFromLabel(`${name} ${r.label || ""}`), name: name.slice(0, 200), thumb: /^https:\/\//.test(r.thumb || "") ? r.thumb : "", authuser };
  });
}

// ── One save each ──────────────────────────────────────────────────────────
// Several Drive files make several saves (each with its own link, words and picture), shown as one batch.
function entriesFor(item) {
  if (item.google?.length) return item.google.map((g) => ({ url: driveItemUrl(g), title: g.name || "", image: g.thumb || "", google: g }));
  return [{ url: item.link || item.page || "", title: item.title || "", image: pinterestOriginal(item.image || "") }];
}
// Highlighted words go first, in quotes, then what the person said.
function notesFor(item, words) { return item.text ? `"${item.text}"\n\n${words}`.trim() : words; }
// The form fields for one save. When the picture itself is attached, its address isn't sent too (no doubles).
function fieldsFor(entry, notes, batch, hasPicture) {
  const f = [["notes", notes]];
  if (/^https?:/.test(entry.url || "")) f.push(["url", entry.url]);
  if (!hasPicture && /^https?:/.test(entry.image || "")) f.push(["image_url", entry.image]);
  if (entry.title) f.push(["title", entry.title.slice(0, 300)]);
  f.push(["remind", "never"]);
  if (batch) f.push(["batch", batch]);
  return f;
}

// ── Reading Google files (background worker, with the person's Google cookies) ──
async function googleGet(url, max = MAX_FILE) {
  try {
    const r = await fetch(url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!r.ok || /^https:\/\/accounts\.google\.com\//.test(r.url)) return null; // a sign-in page is not the file
    if (Number(r.headers.get("content-length") || 0) > max) return null;
    return r;
  } catch { return null; }
}
// The body, or null once it passes max (a big video isn't read into memory just to be dropped).
async function readCapped(r, max = MAX_FILE) {
  if (!r.body) { const b = await r.arrayBuffer().catch(() => null); return b && b.byteLength <= max ? new Uint8Array(b) : null; }
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: null }));
    if (done) break; n += value.length; if (n > max) { reader.cancel().catch(() => {}); return null; } parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
}
// One Drive item's contents for the save: the words of a Doc, Sheet or Slides; the file itself for
// pictures and documents; and Drive's preview picture when there is no picture otherwise.
async function fetchGoogleFiles(g) {
  let kind = g.kind || "";
  // Not sure what it is: Drive's own link redirects to the right editor, which says.
  if (!kind) { const r = await googleGet(withAuthuser(`https://drive.google.com/open?id=${g.id}`, g.authuser), Infinity); kind = (r && googleFromUrl(r.url)?.kind) || "file"; r?.body?.cancel().catch(() => {}); }
  const files = [], name = g.name || "";
  if (kind === "folder") return { kind, files };
  for (const x of exportUrls({ ...g, kind })) {
    const r = await googleGet(x.url, 4 * 1024 * 1024); if (!r || /html/i.test(r.headers.get("content-type") || "")) continue;
    const text = await r.text().catch(() => ""); if (!text.trim()) continue;
    files.push({ name: safeFileName(name || "Google file", x.ext), type: x.type, text }); break;
  }
  if (!DOC_KINDS_SET.has(kind)) {
    const r = await googleGet(downloadUrl(g));
    if (r && !/html/i.test(r.headers.get("content-type") || "")) {
      const bytes = await readCapped(r); const type = typeFor(name, r.headers.get("content-type"));
      if (bytes && bytes.length > 200) files.push({ name: safeFileName(name || "file", /\.[a-z0-9]{2,5}$/i.test(name) ? "" : extFor(type)), type, b64: bytesToBase64(bytes) });
    }
  }
  if (!files.some((f) => f.type.startsWith("image/"))) {
    const r = await googleGet(thumbnailUrl(g), 5 * 1024 * 1024); const type = r?.headers.get("content-type") || "";
    const bytes = r && type.startsWith("image/") ? await readCapped(r) : null;
    if (bytes && bytes.length > 200) files.unshift({ name: `preview.${extFor(type)}`, type: type.split(";")[0], b64: bytesToBase64(bytes) });
  }
  return { kind, files };
}
const DOC_KINDS_SET = new Set(["doc", "sheet", "slides"]);

// ── Run inside the web page (chrome.scripting): self-contained ───────────────
// Drive's selected tiles and rows carry the file id in data-id; the type icon's address names its type.
function readDriveSelection() {
  const out = [];
  for (const el of document.querySelectorAll('[aria-selected="true"][data-id]')) {
    const imgs = [...el.querySelectorAll("img")];
    const icon = imgs.map((i) => i.src).find((s) => /\/type\//.test(s)) || "";
    const thumb = imgs.find((i) => !/\/type\//.test(i.src) && (i.naturalWidth || i.width) >= 48);
    out.push({ id: el.getAttribute("data-id"), mime: (icon.match(/\/type\/([^?#]+)/) || [])[1] || "", label: el.getAttribute("aria-label") || "",
      name: el.querySelector("[data-tooltip]")?.getAttribute("data-tooltip") || el.innerText || el.getAttribute("aria-label") || "", thumb: thumb ? thumb.currentSrc || thumb.src : "" });
  }
  return out;
}
// The picture's bytes as the page has them (blob:, data:, behind the site's sign-in). null when the
// page can't read it (most pictures from another site), and the server fetches the address instead.
async function pictureBytes(src) {
  try {
    const r = await fetch(src, { signal: AbortSignal.timeout(8000) }); if (!r.ok) return null;
    const b = await r.blob(); if (!/^image\//.test(b.type) || b.size < 200 || b.size > 15 * 1024 * 1024) return null;
    return await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => res(null); f.readAsDataURL(b); });
  } catch { return null; }
}

if (typeof module === "object" && module.exports) module.exports = { GOOGLE_ORIGINS, pinterestOriginal, pinterestFallback, isPinterest, extFor, typeFor, dataUrlToBlob, bytesToBase64, base64ToBytes, authuserOf, withAuthuser, googleFromUrl, kindFromMime, kindFromLabel, driveItemUrl, exportUrls, downloadUrl, thumbnailUrl, cleanTitle, safeFileName, driveItemsFrom, entriesFor, notesFor, fieldsFor, fetchGoogleFiles, readCapped };
