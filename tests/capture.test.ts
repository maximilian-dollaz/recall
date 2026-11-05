// Saving from Chrome (extension/): the address rewriting and form fields are pure and tested directly;
// the background worker and the pop-up are run for real against a fake `chrome` (vm and jsdom), because
// nobody can load the extension into Chrome from here. Nothing leaves this machine: every fetch is faked.
// Run: bun test tests/capture.test.ts

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const EXT = join(import.meta.dir, "..", "extension");
const src = (f: string) => readFileSync(join(EXT, f), "utf8");
const cap = require("../extension/capture.js");

const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const IMG = "1ImageIdImageIdImageIdImageId00";
const PDF = "1PdfIdPdfIdPdfIdPdfIdPdfId00000";

describe("pictures", () => {
  test("Pinterest small copies become the original, and fall back to 736x", () => {
    for (const size of ["236x", "474x", "564x", "736x"]) expect(cap.pinterestOriginal(`https://i.pinimg.com/${size}/ab/cd/ef/abcdef.jpg`)).toBe("https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg");
    expect(cap.pinterestFallback("https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg")).toBe("https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg");
    // Avatars, other sites and already-fallen-back addresses are left alone.
    expect(cap.pinterestOriginal("https://i.pinimg.com/75x75_RS/ab/cd.jpg")).toBe("https://i.pinimg.com/75x75_RS/ab/cd.jpg");
    expect(cap.pinterestOriginal("https://example.com/236x/a.jpg")).toBe("https://example.com/236x/a.jpg");
    expect(cap.pinterestFallback("https://i.pinimg.com/736x/a.jpg")).toBe("https://i.pinimg.com/736x/a.jpg");
    expect(cap.isPinterest("https://i.pinimg.com/originals/a.jpg")).toBe(true);
  });

  test("data: URLs and base64 turn back into the same bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect([...cap.base64ToBytes(cap.bytesToBase64(bytes))]).toEqual([...bytes]);
    const blob = cap.dataUrlToBlob(`data:image/png;base64,${cap.bytesToBase64(bytes)}`);
    expect(blob.type).toBe("image/png"); expect(blob.size).toBe(6);
    expect(cap.dataUrlToBlob("not a data url")).toBeNull();
  });

  test("file types from Drive's octet-stream answers come from the name", () => {
    expect(cap.typeFor("Room.JPEG", "application/octet-stream")).toBe("image/jpeg");
    expect(cap.typeFor("plan.pdf", "")).toBe("application/pdf");
    expect(cap.typeFor("x.png", "image/webp; charset=binary")).toBe("image/webp");
    expect(cap.extFor("image/jpeg")).toBe("jpg");
  });
});

describe("Google addresses", () => {
  test("Docs, Sheets, Slides, Drive files and folders are recognised, with the account", () => {
    expect(cap.googleFromUrl(`https://docs.google.com/document/d/${DOC}/edit?tab=t.0`)).toEqual({ id: DOC, kind: "doc", authuser: "" });
    expect(cap.googleFromUrl(`https://docs.google.com/spreadsheets/u/1/d/${DOC}/edit#gid=0`)).toEqual({ id: DOC, kind: "sheet", authuser: "1" });
    expect(cap.googleFromUrl(`https://docs.google.com/presentation/d/${DOC}/edit?authuser=2`)).toEqual({ id: DOC, kind: "slides", authuser: "2" });
    expect(cap.googleFromUrl(`https://drive.google.com/file/d/${IMG}/view`)).toEqual({ id: IMG, kind: "", authuser: "" });
    expect(cap.googleFromUrl(`https://drive.google.com/drive/u/3/folders/${DOC}`)).toEqual({ id: DOC, kind: "folder", authuser: "3" });
    expect(cap.googleFromUrl(`https://drive.google.com/open?id=${DOC}`)).toEqual({ id: DOC, kind: "", authuser: "" });
    expect(cap.googleFromUrl("https://drive.google.com/drive/recent")).toBeNull();
    expect(cap.googleFromUrl("https://docs.google.com/forms/d/abc/edit")).toBeNull();
    expect(cap.googleFromUrl("https://example.com/document/d/x")).toBeNull();
  });

  test("each kind of Drive item gets its own address and export", () => {
    expect(cap.driveItemUrl({ id: DOC, kind: "doc" })).toBe(`https://docs.google.com/document/d/${DOC}/edit`);
    expect(cap.driveItemUrl({ id: DOC, kind: "sheet", authuser: "1" })).toBe(`https://docs.google.com/spreadsheets/d/${DOC}/edit?authuser=1`);
    expect(cap.driveItemUrl({ id: DOC, kind: "folder" })).toBe(`https://drive.google.com/drive/folders/${DOC}`);
    expect(cap.driveItemUrl({ id: IMG, kind: "image", authuser: "0" })).toBe(`https://drive.google.com/file/d/${IMG}/view`);
    expect(cap.exportUrls({ id: DOC, kind: "doc" }).map((x: any) => x.url)).toEqual([`https://docs.google.com/document/d/${DOC}/export?format=md`, `https://docs.google.com/document/d/${DOC}/export?format=txt`]);
    expect(cap.exportUrls({ id: DOC, kind: "sheet", authuser: "1" })[0]).toEqual({ url: `https://docs.google.com/spreadsheets/d/${DOC}/export?format=csv&authuser=1`, ext: "csv", type: "text/csv" });
    expect(cap.exportUrls({ id: DOC, kind: "slides" })[0].ext).toBe("txt");
    expect(cap.exportUrls({ id: IMG, kind: "image" })).toEqual([]);
    expect(cap.downloadUrl({ id: IMG, authuser: "1" })).toBe(`https://drive.google.com/uc?export=download&id=${IMG}&authuser=1`);
  });

  test("titles and file names are tidied", () => {
    expect(cap.cleanTitle("Frequency room plan - Google Docs")).toBe("Frequency room plan");
    expect(cap.cleanTitle("Budget – Google Sheets")).toBe("Budget");
    expect(cap.safeFileName("Room: plan / v2", "md")).toBe("Room- plan - v2.md");
    expect(cap.safeFileName("notes.md", "md")).toBe("notes.md");
    expect(cap.safeFileName("", "txt")).toBe("file.txt");
  });

  test("what the Drive page reports becomes clean items: type from the icon, else the label", () => {
    const raw = [
      { id: DOC, mime: "application/vnd.google-apps.document", label: "", name: "Room plan\nGoogle Docs\nYou opened today", thumb: "https://lh3.google.com/u/0/d/x=w200" },
      { id: IMG, mime: "", label: "Wall.png Image", name: "Wall.png", thumb: "" },
      { id: IMG, mime: "", label: "duplicate", name: "dup", thumb: "" },
      { id: "my-drive", mime: "", label: "My Drive", name: "My Drive", thumb: "" },
      { id: PDF, mime: "application/pdf", label: "", name: "Menu.pdf", thumb: "blob:https://drive.google.com/x" },
    ];
    expect(cap.driveItemsFrom(raw, "https://drive.google.com/drive/u/1/recent")).toEqual([
      { id: DOC, kind: "doc", name: "Room plan", thumb: "https://lh3.google.com/u/0/d/x=w200", authuser: "1" },
      { id: IMG, kind: "image", name: "Wall.png", thumb: "", authuser: "1" },
      { id: PDF, kind: "file", name: "Menu.pdf", thumb: "", authuser: "1" },
    ]);
    expect(cap.driveItemsFrom(null, "")).toEqual([]);
    expect(cap.kindFromLabel("Q3 budget Google Sheets")).toBe("sheet");
    expect(cap.kindFromLabel("Lounge references Shared folder")).toBe("folder");
  });
});

describe("save fields", () => {
  test("a Drive selection is one save per file; a page is one save with its picture and title", () => {
    const drive = cap.entriesFor({ page: "https://drive.google.com/drive/recent", title: "Recent - Google Drive", google: [{ id: DOC, kind: "doc", name: "Room plan", thumb: "https://lh3.google.com/t" }, { id: IMG, kind: "image", name: "Wall.png" }] });
    expect(drive.map((e: any) => [e.url, e.title, e.image])).toEqual([[`https://docs.google.com/document/d/${DOC}/edit`, "Room plan", "https://lh3.google.com/t"], [`https://drive.google.com/file/d/${IMG}/view`, "Wall.png", ""]]);
    const pin = cap.entriesFor({ page: "https://www.pinterest.com/", link: "https://www.pinterest.com/pin/123/", image: "https://i.pinimg.com/236x/a/b.jpg", title: "Pinterest" });
    expect(pin).toEqual([{ url: "https://www.pinterest.com/pin/123/", title: "Pinterest", image: "https://i.pinimg.com/originals/a/b.jpg" }]);
  });

  test("fields: notes, link, picture address only when the picture isn't attached, title, batch", () => {
    const e = { url: "https://site.com/p", title: "A page", image: "https://site.com/a.jpg" };
    expect(cap.fieldsFor(e, "for Zero Proof", "", false)).toEqual([["notes", "for Zero Proof"], ["url", "https://site.com/p"], ["image_url", "https://site.com/a.jpg"], ["title", "A page"], ["remind", "never"]]);
    expect(cap.fieldsFor(e, "x", "chrome-1", true)).toEqual([["notes", "x"], ["url", "https://site.com/p"], ["title", "A page"], ["remind", "never"], ["batch", "chrome-1"]]);
    // blob:, data: and chrome-extension: addresses are never sent as links.
    expect(cap.fieldsFor({ url: "chrome-extension://abc/permission.html", title: "", image: "blob:https://x/1" }, "n", "", false)).toEqual([["notes", "n"], ["remind", "never"]]);
    expect(cap.notesFor({ text: "green glass" }, "for the bar")).toBe('"green glass"\n\nfor the bar');
    expect(cap.notesFor({}, "just words")).toBe("just words");
  });

  test("the manifest asks for exactly the Google sites the pop-up requests, and every file it names exists", () => {
    const m = JSON.parse(src("manifest.json"));
    expect(m.version).toBe("0.3.0");
    expect(m.optional_host_permissions).toEqual(cap.GOOGLE_ORIGINS);
    const recall = src("recorder.js").match(/const RECALL = "([^"]+)"/)![1];
    expect(m.host_permissions).toEqual([`${recall}/*`]); // change both together for your own Recall
    for (const f of [m.background.service_worker, m.action.default_popup, ...Object.values(m.icons), "capture.js", "permission.html", "permission.js"]) expect(existsSync(join(EXT, f as string))).toBe(true);
  });
});

// ── Reading Google files, with a fake Google ───────────────────────────────
function fakeGoogle(routes: Record<string, () => Response | null>) {
  const calls: { url: string; credentials?: string }[] = [];
  const fetch = async (url: string, init: any = {}) => {
    calls.push({ url, credentials: init.credentials });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]() : null;
    if (!r) return new Response("no", { status: 404 });
    return r;
  };
  return { fetch, calls };
}
const at = (r: Response, url: string) => Object.defineProperty(r, "url", { value: url });

describe("Google files", () => {
  test("a Doc: its Markdown export and Drive's picture of it, read with the person's cookies", async () => {
    const g = fakeGoogle({
      [`https://docs.google.com/document/d/${DOC}/export?format=md`]: () => new Response("# Room plan\n\nConcrete walls.", { headers: { "content-type": "text/markdown" } }),
      [`https://drive.google.com/thumbnail?id=${DOC}`]: () => new Response(new Uint8Array(500), { headers: { "content-type": "image/png" } }),
    });
    const saved = globalThis.fetch; globalThis.fetch = g.fetch as any;
    try {
      const r = await cap.fetchGoogleFiles({ id: DOC, kind: "doc", name: "Room plan" });
      expect(r.kind).toBe("doc");
      expect(r.files.map((f: any) => [f.name, f.type])).toEqual([["preview.png", "image/png"], ["Room plan.md", "text/markdown"]]);
      expect(r.files[1].text).toContain("Concrete walls");
      expect(g.calls.every((c) => c.credentials === "include")).toBe(true);
      expect(g.calls.some((c) => c.url.includes("uc?export=download"))).toBe(false); // a Doc is exported, not downloaded
    } finally { globalThis.fetch = saved; }
  });

  test("a Doc whose Markdown export fails falls back to text; a sign-in page is never taken as the file", async () => {
    const g = fakeGoogle({
      [`https://docs.google.com/document/d/${DOC}/export?format=md`]: () => at(new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }), "https://accounts.google.com/signin"),
      [`https://docs.google.com/document/d/${DOC}/export?format=txt`]: () => new Response("Plain words", { headers: { "content-type": "text/plain" } }),
    });
    const saved = globalThis.fetch; globalThis.fetch = g.fetch as any;
    try {
      const r = await cap.fetchGoogleFiles({ id: DOC, kind: "doc", name: "Plan" });
      expect(r.files).toEqual([{ name: "Plan.txt", type: "text/plain", text: "Plain words" }]);
    } finally { globalThis.fetch = saved; }
  });

  test("a picture in Drive: the original file, no preview needed; an unknown type is asked of Drive", async () => {
    const g = fakeGoogle({
      [`https://drive.google.com/open?id=${IMG}`]: () => at(new Response("viewer"), `https://drive.google.com/file/d/${IMG}/view`),
      [`https://drive.google.com/uc?export=download&id=${IMG}`]: () => new Response(new Uint8Array(4000).fill(7), { headers: { "content-type": "application/octet-stream" } }),
    });
    const saved = globalThis.fetch; globalThis.fetch = g.fetch as any;
    try {
      const r = await cap.fetchGoogleFiles({ id: IMG, kind: "", name: "Wall.png" });
      expect(r.kind).toBe("file");
      expect(r.files.map((f: any) => [f.name, f.type])).toEqual([["Wall.png", "image/png"]]);
      expect(cap.base64ToBytes(r.files[0].b64).length).toBe(4000);
      expect(g.calls.some((c) => c.url.includes("/thumbnail"))).toBe(false);
    } finally { globalThis.fetch = saved; }
  });

  test("Drive says an unknown item is a Doc: it is exported as one", async () => {
    const g = fakeGoogle({
      [`https://drive.google.com/open?id=${DOC}`]: () => at(new Response("editor"), `https://docs.google.com/document/d/${DOC}/edit`),
      [`https://docs.google.com/document/d/${DOC}/export?format=md`]: () => new Response("words", { headers: { "content-type": "text/markdown" } }),
    });
    const saved = globalThis.fetch; globalThis.fetch = g.fetch as any;
    try { const r = await cap.fetchGoogleFiles({ id: DOC, kind: "", name: "" }); expect(r.kind).toBe("doc"); expect(r.files.map((f: any) => f.name)).toEqual(["Google file.md"]); }
    finally { globalThis.fetch = saved; }
  });

  test("too big to carry: skipped (only the preview goes), and a folder fetches nothing", async () => {
    const g = fakeGoogle({
      [`https://drive.google.com/uc?export=download&id=${PDF}`]: () => new Response("x", { headers: { "content-type": "application/pdf", "content-length": String(40 * 1024 * 1024) } }),
      [`https://drive.google.com/thumbnail?id=${PDF}`]: () => new Response(new Uint8Array(900), { headers: { "content-type": "image/jpeg" } }),
    });
    const saved = globalThis.fetch; globalThis.fetch = g.fetch as any;
    try {
      const r = await cap.fetchGoogleFiles({ id: PDF, kind: "file", name: "Menu.pdf" });
      expect(r.files.map((f: any) => f.name)).toEqual(["preview.jpg"]);
      g.calls.length = 0;
      expect((await cap.fetchGoogleFiles({ id: DOC, kind: "folder", name: "Refs" })).files).toEqual([]);
      expect(g.calls.length).toBe(0);
    } finally { globalThis.fetch = saved; }
  });

  test("a stream that runs past the limit is dropped without reading it all", async () => {
    const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }));
    expect(await cap.readCapped(big, 3 * 1024 * 1024)).toBeNull();
    expect((await cap.readCapped(new Response(new Uint8Array(10)), 100))!.length).toBe(10);
  });
});

// ── The background worker, run for real against a fake chrome ─────────────
function fakeChrome(opts: { scriptResult?: (func: Function, args: any[]) => any; granted?: boolean; tab?: any; pending?: any; reply?: (m: any) => any } = {}) {
  const session: Record<string, any> = opts.pending ? { pending: opts.pending } : {};
  const log: any = { created: [], scripts: [], opened: 0, windows: 0, requested: [] };
  const listeners: Record<string, Function[]> = {};
  const on = (name: string) => ({ addListener: (f: Function) => (listeners[name] ||= []).push(f) });
  const chrome = {
    runtime: { onInstalled: on("installed"), onMessage: on("message"), onConnect: on("connect"), connect: () => ({ onDisconnect: on("disc") }),
      sendMessage: async (m: any) => opts.reply?.(m) },
    contextMenus: { create: (x: any) => log.created.push(x), onClicked: on("clicked") },
    permissions: { onAdded: on("added"), contains: async () => !!opts.granted, request: async (p: any) => { log.requested.push(p); return true; } },
    storage: {
      session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: any) => Object.assign(session, o), remove: async (k: string) => { delete session[k]; } },
      local: { get: async () => ({ micAllowed: true }), set: async () => {} },
    },
    scripting: { executeScript: async (o: any) => { log.scripts.push(o); return [{ result: opts.scriptResult?.(o.func, o.args || []) }]; } },
    action: { openPopup: async () => { log.opened++; } },
    windows: { getCurrent: async () => null, create: () => log.windows++ },
    tabs: { create: (x: any) => log.created.push(x), query: async () => [opts.tab] },
  };
  return { chrome, session, log, listeners };
}

function runBackground(fc: ReturnType<typeof fakeChrome>) {
  const ctx: any = vm.createContext({ chrome: fc.chrome, URL, console, setTimeout, AbortSignal, Blob, TextEncoder, atob, btoa, fetch: async () => new Response("", { status: 404 }) });
  ctx.importScripts = (f: string) => vm.runInContext(src(f), ctx);
  vm.runInContext(src("background.js"), ctx);
  return (info: any, tab: any) => fc.listeners.clicked[0]({ menuItemId: "add-to-recall", ...info }, tab);
}

describe("right-click → Add to Recall (background.js)", () => {
  test("inside a Google Doc: the Doc itself, named as the tab names it", async () => {
    const fc = fakeChrome();
    await runBackground(fc)({ pageUrl: `https://docs.google.com/document/u/1/d/${DOC}/edit` }, { id: 7, title: "Frequency room plan - Google Docs" });
    expect(fc.session.pending.google).toEqual([{ id: DOC, kind: "doc", authuser: "1", name: "Frequency room plan" }]);
    expect(fc.session.pending.title).toBe("Frequency room plan - Google Docs");
    expect(fc.log.opened).toBe(1);
  });

  test("in Drive: every selected file", async () => {
    const fc = fakeChrome({ scriptResult: (f) => (f.name === "readDriveSelection" ? [{ id: DOC, mime: "application/vnd.google-apps.spreadsheet", name: "Budget" }, { id: IMG, mime: "image/jpeg", name: "Wall.jpg" }] : "") });
    await runBackground(fc)({ pageUrl: "https://drive.google.com/drive/recent" }, { id: 7, title: "Recent - Google Drive" });
    expect(fc.session.pending.google.map((g: any) => [g.kind, g.name])).toEqual([["sheet", "Budget"], ["image", "Wall.jpg"]]);
  });

  test("a link to a Doc anywhere: that Doc, without looking for a picture", async () => {
    const fc = fakeChrome();
    await runBackground(fc)({ pageUrl: "https://mail.google.com/mail/u/0/", linkUrl: `https://docs.google.com/presentation/d/${DOC}/edit` }, { id: 7, title: "Inbox" });
    expect(fc.session.pending.google).toEqual([{ id: DOC, kind: "slides", authuser: "" }]);
    expect(fc.log.scripts.length).toBe(0);
  });

  test("Pinterest pin right-clicked as a link: the picture inside it, and no Google lookups", async () => {
    const fc = fakeChrome({ scriptResult: () => "https://i.pinimg.com/736x/aa/bb/cc.jpg" });
    await runBackground(fc)({ pageUrl: "https://www.pinterest.com/", linkUrl: "https://www.pinterest.com/pin/123/", frameId: 0 }, { id: 9, title: "Pinterest" });
    expect(fc.session.pending).toMatchObject({ image: "https://i.pinimg.com/736x/aa/bb/cc.jpg", link: "https://www.pinterest.com/pin/123/", tabId: 9, title: "Pinterest" });
    expect(fc.session.pending.google).toBeUndefined();
  });

  test("Chrome won't open the pop-up: a small window instead (as before)", async () => {
    const fc = fakeChrome(); fc.chrome.action.openPopup = async () => { throw new Error("no"); };
    await runBackground(fc)({ pageUrl: "https://example.com/", srcUrl: "https://example.com/a.jpg" }, { id: 1, title: "Ex" });
    expect(fc.log.windows).toBe(1);
  });

  test("Google allowed after the question closed the pop-up: it opens again for the same files", async () => {
    const fc = fakeChrome({ pending: { page: "https://drive.google.com/", google: [{ id: DOC, kind: "doc" }], at: Date.now() } });
    runBackground(fc);
    await fc.listeners.added[0]();
    expect(fc.log.opened).toBe(1);
  });
});

// ── The pop-up, run for real in jsdom ────────────────────────────────────────
async function runPopup(fc: ReturnType<typeof fakeChrome>, posts: { fields: [string, any][] }[]) {
  const html = src("recorder.html").replace(/<script[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://recall/recorder.html" });
  const w: any = dom.window;
  w.chrome = fc.chrome;
  w.fetch = async (_url: string, init: any) => { posts.push({ fields: [...init.body.entries()] }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  w.close = () => {};
  // Chrome shares top-level names between a page's scripts; jsdom's eval doesn't, so they run as one.
  w.eval(`${src("capture.js")}\n${src("recorder.js")}`);
  for (let i = 0; i < 20 && w.document.querySelector("#typed").hidden; i++) await Bun.sleep(5); // no microphone here: typing
  return w;
}
async function typeAndSave(w: any, words: string) {
  w.document.querySelector("#typed").value = words;
  w.document.querySelector("#savebtn").click();
  for (let i = 0; i < 100 && !/Saved|Not saved|Sign in/.test(w.document.querySelector("#status").textContent); i++) await Bun.sleep(10);
  return w.document.querySelector("#status").textContent;
}

describe("the pop-up (recorder.js)", () => {
  test("Drive, two files, Google allowed: two saves in one batch, each with its link, name and contents", async () => {
    const posts: any[] = [];
    const fc = fakeChrome({
      granted: true, tab: { id: 3, url: "https://drive.google.com/drive/recent", title: "Recent - Google Drive" },
      scriptResult: (f) => (f.name === "readDriveSelection" ? [{ id: DOC, mime: "application/vnd.google-apps.document", name: "Room plan" }, { id: IMG, mime: "image/png", name: "Wall.png" }] : null),
      reply: (m) => (m.entry.kind === "doc" ? { kind: "doc", files: [{ name: "Room plan.md", type: "text/markdown", text: "# Room plan" }] } : { kind: "image", files: [{ name: "Wall.png", type: "image/png", b64: cap.bytesToBase64(new Uint8Array(300)) }] }),
    });
    const w = await runPopup(fc, posts);
    expect(w.document.querySelector("#what").textContent).toBe("2 files: Room plan, Wall.png");
    expect(w.document.querySelector("#many").hidden).toBe(false);
    expect(w.document.querySelector("#allow").hidden).toBe(true);
    expect(await typeAndSave(w, "For Frequency, the lounge layouts")).toBe("Saved to Recall.");
    expect(posts.length).toBe(2);
    const f0 = Object.fromEntries(posts[0].fields.filter(([k]: any) => k !== "files")), f1 = Object.fromEntries(posts[1].fields.filter(([k]: any) => k !== "files"));
    expect(f0).toMatchObject({ notes: "For Frequency, the lounge layouts", url: `https://docs.google.com/document/d/${DOC}/edit`, title: "Room plan", remind: "never" });
    expect(f1).toMatchObject({ url: `https://drive.google.com/file/d/${IMG}/view`, title: "Wall.png" });
    expect(f0.batch).toBeTruthy(); expect(f0.batch).toBe(f1.batch);
    expect(posts[0].fields.find(([k]: any) => k === "files")[1].name).toBe("Room plan.md");
    expect(posts[1].fields.find(([k]: any) => k === "files")[1].type).toBe("image/png");
    expect(posts[1].fields.some(([k]: any) => k === "image_url")).toBe(false);
  });

  test("a Doc, Google not allowed yet: the Allow button shows, and the link and name are still saved", async () => {
    const posts: any[] = [];
    const fc = fakeChrome({ granted: false, tab: { id: 3, url: `https://docs.google.com/document/d/${DOC}/edit`, title: "Room plan - Google Docs" }, reply: () => { throw new Error("must not read Google without permission"); } });
    const w = await runPopup(fc, posts);
    expect(w.document.querySelector("#allow").hidden).toBe(false);
    expect(await typeAndSave(w, "for zero proof")).toBe("Saved to Recall.");
    expect(posts.length).toBe(1);
    expect(Object.fromEntries(posts[0].fields)).toEqual({ notes: "for zero proof", url: `https://docs.google.com/document/d/${DOC}/edit`, title: "Room plan", remind: "never" });
  });

  test("Allow: asks Chrome for exactly the Google sites, keeps the files in case the pop-up closes, then reads them", async () => {
    const posts: any[] = []; let asked = 0;
    const fc = fakeChrome({ granted: false, tab: { id: 3, url: `https://docs.google.com/document/d/${DOC}/edit`, title: "Plan - Google Docs" }, reply: () => { asked++; return { kind: "doc", files: [{ name: "Plan.md", type: "text/markdown", text: "hi" }] }; } });
    const w = await runPopup(fc, posts);
    w.document.querySelector("#allowbtn").click();
    await Bun.sleep(20);
    expect(fc.log.requested).toEqual([{ origins: cap.GOOGLE_ORIGINS }]);
    expect(asked).toBe(1);
    expect(w.document.querySelector("#allow").hidden).toBe(true);
    expect(await typeAndSave(w, "plan")).toBe("Saved to Recall.");
    expect(posts[0].fields.find(([k]: any) => k === "files")[1].name).toBe("Plan.md");
  });

  test("a right-clicked Pinterest picture: the original's address and the tab's title (as before, plus title)", async () => {
    const posts: any[] = [];
    const fc = fakeChrome({ pending: { page: "https://www.pinterest.com/", link: "https://www.pinterest.com/pin/1/", image: "https://i.pinimg.com/236x/a/b.jpg", title: "Pinterest", tabId: 4, at: Date.now() } });
    const w = await runPopup(fc, posts);
    expect(fc.session.pending).toBeUndefined(); // taken once: the next toolbar click starts fresh
    const t = w.document.querySelector("#thumb");
    expect(t.src).toBe("https://i.pinimg.com/originals/a/b.jpg");
    t.dispatchEvent(new w.Event("error")); // no original for this pin
    expect(t.src).toBe("https://i.pinimg.com/736x/a/b.jpg");
    t.dispatchEvent(new w.Event("load"));
    expect(await typeAndSave(w, "spider-man for the bar")).toBe("Saved to Recall.");
    expect(Object.fromEntries(posts[0].fields)).toEqual({ notes: "spider-man for the bar", url: "https://www.pinterest.com/pin/1/", image_url: "https://i.pinimg.com/736x/a/b.jpg", title: "Pinterest", remind: "never" });
    expect(fc.log.scripts.length).toBe(0); // Pinterest's own copy is fetched by the server, not read in the page
  });

  test("a blob: picture: its bytes are read in the page and attached; highlighted words are quoted", async () => {
    const posts: any[] = [];
    const png = `data:image/png;base64,${cap.bytesToBase64(new Uint8Array(400))}`;
    const fc = fakeChrome({ pending: { page: "https://site.com/a", image: "blob:https://site.com/123", text: "green glass", title: "Site", tabId: 5, frameId: 2, at: Date.now() }, scriptResult: (f, a) => (f.name === "pictureBytes" && a[0] === "blob:https://site.com/123" ? png : null) });
    const w = await runPopup(fc, posts);
    w.document.querySelector("#thumb").dispatchEvent(new w.Event("error")); // as in Chrome: the pop-up can't load the page's blob: address
    expect(await typeAndSave(w, "the glow")).toBe("Saved to Recall.");
    expect(fc.log.scripts[0].target).toEqual({ tabId: 5, frameIds: [2] });
    const fields = posts[0].fields;
    expect(fields.find(([k]: any) => k === "notes")[1]).toBe('"green glass"\n\nthe glow');
    expect(fields.find(([k]: any) => k === "files")[1].name).toBe("picture.png");
    expect(fields.some(([k]: any) => k === "image_url")).toBe(false);
  });

  test("an old right-click left behind is ignored: the toolbar saves the page you're on", async () => {
    const posts: any[] = [];
    const fc = fakeChrome({ pending: { page: "https://old.com/", image: "https://old.com/a.jpg", at: Date.now() - 10 * 60_000 }, tab: { id: 1, url: "https://new.com/", title: "New" } });
    const w = await runPopup(fc, posts);
    expect(await typeAndSave(w, "x")).toBe("Saved to Recall.");
    expect(Object.fromEntries(posts[0].fields)).toEqual({ notes: "x", url: "https://new.com/", title: "New", remind: "never" });
  });

  test("one of several fails: says how many went, and a retry sends only the rest", async () => {
    const posts: any[] = []; let n = 0;
    const fc = fakeChrome({ granted: false, tab: { id: 3, url: "https://drive.google.com/drive/recent", title: "Recent" },
      scriptResult: () => [{ id: DOC, mime: "image/png", name: "A.png" }, { id: IMG, mime: "image/png", name: "B.png" }] });
    const w = await runPopup(fc, posts);
    w.fetch = async (_u: string, init: any) => { n++; if (n === 2) return new Response(JSON.stringify({ error: "disk full" }), { status: 507 }); posts.push({ fields: [...init.body.entries()] }); return new Response(JSON.stringify({ ok: true })); };
    expect(await typeAndSave(w, "refs")).toBe("Saved 1 of 2. Not saved: disk full");
    expect(fc.session.pending.google.map((g: any) => g.name)).toEqual(["B.png"]); // kept for later, only what didn't go
    w.document.querySelector("#savebtn").click();
    for (let i = 0; i < 100 && posts.length < 2; i++) await Bun.sleep(10);
    expect(posts.map((p) => Object.fromEntries(p.fields).title)).toEqual(["A.png", "B.png"]);
  });
});
