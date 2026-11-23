// Connectors: the list is honest with nothing set up, a Metricool post is always a draft carrying the person's
// own words untouched, and the Apple Notes script picks, caps and remembers correctly. Everything runs in temp
// folders with a stubbed fetch and a stubbed Notes reader: no service, no Notes app, no real key is touched.

import { test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recall-connectors-test-"));
process.env.RECALL_DATA = ROOT;
process.env.RECALL_KEYS_DIR = join(ROOT, "keys");
process.env.RECALL_CONNECTORS = join(ROOT, "connectors");
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"]) delete process.env[k];
mkdirSync(join(ROOT, "library"), { recursive: true }); mkdirSync(join(ROOT, "keys"), { recursive: true });

const connectors = await import("../app/connectors.ts");
const social = await import("../app/social.ts");
const canva = await import("../app/canva.ts");
const files = await import("../app/connector-store.ts");
const notes = await import("../tools/sync-apple-notes.ts");

const realFetch = globalThis.fetch;
const me = { id: "sam", name: "Sam", email: "sam@example.com", source: "default", dir: join(ROOT, "library") };
const setKey = (name: string, v: string | null) => v === null ? rmSync(join(ROOT, "keys", `${name}.key`), { force: true }) : writeFileSync(join(ROOT, "keys", `${name}.key`), v, { mode: 0o600 });
type Call = { url: URL; method: string; headers: Headers; body: any };
function mockFetch(answer: (c: Call) => unknown = () => ({ data: { id: 77, draft: true } })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c = { url: new URL(String(input)), method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(c); const a = answer(c);
    return a instanceof Response ? a : Response.json(a);
  }) as any;
  return calls;
}
const quiet = async <T>(fn: () => Promise<T>) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
afterEach(() => { globalThis.fetch = realFetch; setKey("metricool", null); setKey("canva", null); setKey("google", null); });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ── The list ─────────────────────────────────────────────────────────────────
test("nothing configured: every connector is listed, honest, and nothing is sent anywhere", () => {
  const calls = mockFetch();
  const list = connectors.all(me);
  expect(calls.length).toBe(0);
  expect(list.map((c) => c.id)).toEqual(["granola", "otter", "apple-notes", "drive", "photos", "voice", "metricool", "canva"]);
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  expect(by.granola.state).toBe("ready"); expect(by.granola.action?.href).toBe("/connect/granola");
  expect(by.otter.state).toBe("ready"); expect(by.otter.action?.href).toBe("/connect/otter");
  expect(by["apple-notes"].state).toBe("needs-you");
  expect(by.drive.state).toBe("needs-you"); expect(by.drive.needs).toBe("A Google setup step, done by the owner"); expect(by.drive.action).toBeUndefined();
  expect(by.photos.state).toBe("shortcut"); expect(by.voice.action?.href).toBe("/guide");
  expect(by.metricool.state).toBe("needs-you"); expect(by.metricool.action).toBeUndefined(); // no button that leads nowhere
  expect(by.canva.state).toBe("needs-you"); expect(by.canva.needs).toContain("Canva key");
  for (const c of list) { expect(["in", "out"]).toContain(c.direction); expect(c.state === "on").toBe(false); expect(`${c.name}${c.what}${c.needs ?? ""}`).not.toMatch(/[!—]/); }
  expect(list.filter((c) => c.direction === "out").map((c) => c.id)).toEqual(["metricool", "canva"]);
});

test("a key box that exists gets a link; keys and secrets saved flip the state, and never show up in the list", () => {
  expect(connectors.all(me, { keyBoxes: ["metricool"] }).find((c) => c.id === "metricool")?.action?.href).toBe("/settings?key=metricool");
  setKey("metricool", "tok-SECRET-1:111:222"); setKey("canva", "cid:csecret-SECRET-2"); setKey("google", "gsecret-SECRET-3");
  writeFileSync(join(ROOT, "library/google.json"), JSON.stringify({ clientId: "abc.apps.googleusercontent.com" }));
  const list = connectors.all(me), by = Object.fromEntries(list.map((c) => [c.id, c]));
  expect(by.metricool.state).toBe("on");
  expect(by.canva.state).toBe("ready"); expect(by.canva.action?.href).toBe("/connect/canva");
  expect(by.drive.state).toBe("ready"); expect(by.drive.action?.href).toBe("/connect/drive");
  expect(JSON.stringify(list)).not.toMatch(/SECRET/);
  rmSync(join(ROOT, "library/google.json"));
});

test("Drive and Canva sign-in links: right scope, state names the person, sign-in file is owner-only, a wrong state is refused", async () => {
  setKey("google", "gsecret"); setKey("canva", "cid:csecret");
  writeFileSync(join(ROOT, "library/google.json"), JSON.stringify({ clientId: "abc.apps.googleusercontent.com" }));
  const g = new URL(connectors.driveStartUrl(me, "https://recall.example.com/connect/drive/callback"));
  expect(g.origin + g.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(g.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
  expect(g.searchParams.get("access_type")).toBe("offline");
  expect(g.searchParams.get("state")!.startsWith("sam.")).toBe(true);
  expect(g.toString()).not.toContain("gsecret");
  expect(statSync(files.pathOf("sam", "drive")).mode & 0o777).toBe(0o600);
  const calls = mockFetch();
  await expect(connectors.driveCallback("code", "sam.wrong", me)).rejects.toThrow(/old/);
  expect(calls.length).toBe(0);
  // The right state: the refresh token is kept, and the list says Drive is on.
  mockFetch(() => ({ access_token: "at", refresh_token: "rt-SECRET", expires_in: 3600 }));
  await connectors.driveCallback("code", g.searchParams.get("state")!, me);
  const drive = connectors.all(me).find((c) => c.id === "drive")!;
  expect(drive.state).toBe("on"); expect(drive.action).toEqual({ label: "Sync now", href: "/api/connectors/drive/sync", post: true });
  expect(JSON.stringify(connectors.all(me))).not.toContain("rt-SECRET");

  const c = new URL(canva.startUrl(me, "https://recall.example.com/connect/canva/callback"));
  expect(c.origin + c.pathname).toBe("https://www.canva.com/api/oauth/authorize");
  expect(c.searchParams.get("code_challenge_method")).toBe("S256"); expect(c.searchParams.get("code_challenge")!.length).toBe(43);
  expect(c.searchParams.get("scope")).toBe("asset:read asset:write");
  await expect(canva.callback(me, "sam.wrong", "code")).rejects.toThrow(/old/);
  connectors.driveDisconnect("sam"); canva.disconnect("sam"); rmSync(join(ROOT, "library/google.json"));
});

test("Drive sync: Docs as text, at most 20 per run, nothing saved twice, the next run carries on", async () => {
  setKey("google", "gsecret"); writeFileSync(join(ROOT, "library/google.json"), JSON.stringify({ clientId: "abc" }));
  mockFetch(() => ({ access_token: "at", refresh_token: "rt" }));
  await connectors.driveCallback("code", new URL(connectors.driveStartUrl(me, "https://r.example.com/cb")).searchParams.get("state")!, me);
  const all = Array.from({ length: 23 }, (_, i) => ({ id: `f${i}`, name: i === 0 ? "Plan/one" : `File ${i}`, mimeType: i % 2 ? "application/pdf" : "application/vnd.google-apps.document", modifiedTime: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }));
  const asked: string[] = [];
  const fake = (async (input: any) => {
    const u = new URL(String(input)); asked.push(u.pathname + u.search);
    if (u.pathname === "/drive/v3/files") { const since = /modifiedTime >= '([^']+)'/.exec(u.searchParams.get("q")!)![1]; return Response.json({ files: all.filter((f) => f.modifiedTime >= since) }); }
    return new Response(u.pathname.endsWith("/export") ? "doc words" : "%PDF-1.4");
  }) as any;
  const saved: { notes: string; source: string; name: string; body: string }[] = [];
  const save = async (_p: unknown, i: { notes: string; files: string[]; source: string }) => { saved.push({ notes: i.notes, source: i.source, name: i.files[0].split("/").pop()!, body: readFileSync(i.files[0], "utf8") }); };
  files.patch<any>("sam", "drive", (s) => { s.connected_at = "2026-11-10T00:00:00.000Z"; });
  const one = await quiet(() => connectors.driveSync(me, save, fake));
  expect(one).toEqual({ saved: 20 });
  expect(saved[0]).toEqual({ notes: "From Google Drive: Plan/one", source: "drive:f0", name: "Plan-one.txt", body: "doc words" });
  expect(saved[1].name).toBe("File 1.pdf");
  expect(asked.find((a) => a.includes("/export"))).toContain("mimeType=text%2Fplain");
  const two = await quiet(() => connectors.driveSync(me, save, fake));
  expect(two).toEqual({ saved: 3 });
  expect(new Set(saved.map((s) => s.source)).size).toBe(23);
  expect((await quiet(() => connectors.driveSync(me, save, fake))).saved).toBe(0);
  connectors.driveDisconnect("sam"); rmSync(join(ROOT, "library/google.json"));
});

// ── Metricool ────────────────────────────────────────────────────────────────
test("Metricool: no key means not ready, and nothing is sent", async () => {
  const calls = mockFetch();
  expect(social.ready()).toBe(false);
  const r = await social.queuePost(me, { networks: ["instagram"], text: "my words", mediaUrls: [] });
  expect(r.ok).toBe(false); expect(r.error).toContain("Metricool"); expect(calls.length).toBe(0);
  setKey("metricool", "only-a-token"); expect(social.ready()).toBe(false);
});

test("Metricool: the request is a draft, to the documented endpoint, with the caller's text passed through untouched", async () => {
  setKey("metricool", "tok-123:111:222\n");
  const calls = mockFetch();
  const text = "  Line one.\n\nLine two #tag   ";
  const r = await quiet(() => social.queuePost(me, { networks: ["instagram", "linkedin"], text, mediaUrls: ["https://cdn.example.com/a.jpg"], when: "2099-03-04T15:30:00Z" }));
  expect(calls.length).toBe(1);
  const c = calls[0];
  expect(c.method).toBe("POST"); expect(c.url.origin + c.url.pathname).toBe("https://app.metricool.com/api/v2/scheduler/posts");
  expect(c.url.searchParams.get("userId")).toBe("111"); expect(c.url.searchParams.get("blogId")).toBe("222");
  expect(c.headers.get("X-Mc-Auth")).toBe("tok-123"); expect(c.url.toString()).not.toContain("tok-123");
  expect(c.body.draft).toBe(true); expect(c.body.autoPublish).toBe(false);
  expect(c.body.text).toBe(text); // not trimmed, not rewritten
  expect(c.body.providers).toEqual([{ network: "instagram" }, { network: "linkedin" }]);
  expect(c.body.media).toEqual(["https://cdn.example.com/a.jpg"]);
  expect(c.body.instagramData).toEqual({ type: "POST" }); expect(c.body.linkedinData).toEqual({}); expect(c.body.tiktokData).toBeUndefined();
  expect(c.body.publicationDate.dateTime).toMatch(/^2099-03-0[345]T\d\d:30:00$/); expect(typeof c.body.publicationDate.timezone).toBe("string");
  expect(r).toEqual({ ok: true, draft: true, id: "77", captionSent: true, note: "Draft saved in Metricool with your caption." });
  expect(JSON.stringify(r)).not.toContain("tok-123");
});

test("Metricool: empty text stays empty and the result says so; no date means tomorrow; a video is a Reel", async () => {
  setKey("metricool", "tok:1:2");
  const calls = mockFetch();
  const r = await quiet(() => social.queuePost(me, { networks: ["instagram", "tiktok"], text: "", mediaUrls: ["https://cdn.example.com/clip.MP4?x=1"] }));
  expect(calls[0].body.text).toBe(""); expect(calls[0].body.draft).toBe(true);
  expect(r.ok).toBe(true); expect(r.captionSent).toBe(false); expect(r.note).toBe("Draft saved in Metricool with no caption. Write it in Metricool.");
  expect(calls[0].body.instagramData).toEqual({ type: "REEL" });
  const now = new Date("2026-11-22T12:00:00Z");
  expect(social.buildDraft({ networks: ["linkedin"], text: "x", mediaUrls: [] }, now, "UTC").publicationDate).toEqual({ dateTime: "2026-11-23T12:00:00", timezone: "UTC" });
  expect(social.buildDraft({ networks: ["linkedin"], text: "x", mediaUrls: [], when: "2020-01-01T00:00:00Z" }, now, "UTC").publicationDate.dateTime).toBe("2026-11-23T12:00:00"); // a past date is never sent
  expect(social.buildDraft({ networks: ["linkedin"], text: "x", mediaUrls: [], when: "2026-12-01T09:00:00Z" }, now, "America/Los_Angeles").publicationDate).toEqual({ dateTime: "2026-12-01T01:00:00", timezone: "America/Los_Angeles" });
  expect(() => social.buildDraft({ networks: [] as any, text: "x", mediaUrls: [] })).toThrow();
  for (const p of [{ networks: ["facebook"], text: "a", mediaUrls: [] }, { networks: ["tiktok"], text: "", mediaUrls: [] }] as any[]) expect(social.buildDraft(p).draft).toBe(true);
});

test("Metricool: a refusal or a post that is not a draft is reported, never called done; the token is not in the error", async () => {
  setKey("metricool", "tok-SECRET:1:2");
  mockFetch(() => new Response("bad token", { status: 401 }));
  const a = await quiet(() => social.queuePost(me, { networks: ["linkedin"], text: "hi", mediaUrls: [] }));
  expect(a.ok).toBe(false); expect(a.error).toContain("401"); expect(JSON.stringify(a)).not.toContain("SECRET");
  mockFetch(() => ({ data: { id: 5, draft: false } }));
  const b = await quiet(() => social.queuePost(me, { networks: ["linkedin"], text: "hi", mediaUrls: [] }));
  expect(b.ok).toBe(false); expect(b.note).toContain("did not keep this as a draft");
});

// ── Apple Notes ──────────────────────────────────────────────────────────────
test("Apple Notes: HTML becomes plain text", () => {
  expect(notes.htmlToText("<div><h1>Title</h1></div><div>One &amp; two&nbsp;three</div><div><br></div><ul><li>first</li><li>second &lt;b&gt;</li></ul><div>caf&#233; &#x1F680;</div>"))
    .toBe("Title\nOne & two three\n\n- first\n- second <b>\ncafé 🚀");
  expect(notes.htmlToText("<style>p{color:red}</style><p>a</p><script>x()</script><p>b</p>")).toBe("a\nb");
  expect(notes.htmlToText("")).toBe("");
});

const listed = (n: number, start = 1) => Array.from({ length: n }, (_, i) => ({ id: `n${i + start}`, title: `Note ${i + start}`, modified: new Date(Date.UTC(2026, 10, 1, 0, i + start)).toISOString(), locked: false }));
const reader = (list: any[]) => ({ list: async () => list, body: async (id: string) => `<div>Body of <b>${id}</b></div>` });

test("Apple Notes: caps at 25, oldest first, skips locked, remembers what was sent, and carries on next run", async () => {
  const list = listed(30); list[2].locked = true;
  const sent: { title: string; text: string }[] = [];
  const now = new Date("2026-11-22T00:00:00Z");
  const one = await notes.run(reader(list), async (n) => { sent.push(n); }, { sent: {} }, { now });
  expect(one.sent).toBe(25); expect(one.more).toBe(true); expect(one.skippedLocked).toBe(1);
  expect(sent[0]).toEqual({ title: "Note 1", text: "Body of n1" });
  expect(sent.some((s) => s.title === "Note 3")).toBe(false); // locked
  expect(Object.keys(one.state.sent).length).toBe(25);
  expect(one.state.last_sync).toBe(list[25].modified); // the 25th sent (n26): the clock stops there, not at "now"
  const two = await notes.run(reader(list), async (n) => { sent.push(n); }, one.state, { now });
  expect(two.sent).toBe(4); expect(two.more).toBe(false); expect(two.state.last_sync).toBe(now.toISOString());
  expect(new Set(sent.map((s) => s.title)).size).toBe(29);
  const three = await notes.run(reader(list), async (n) => { sent.push(n); }, two.state, { now: new Date("2026-11-23T00:00:00Z") });
  expect(three.sent).toBe(0); expect(sent.length).toBe(29);
});

test("Apple Notes: the first run only looks 30 days back; a dry run sends and records nothing; a failed send keeps what was sent", async () => {
  const now = new Date("2026-11-22T00:00:00Z");
  const old = { id: "old", title: "Old", modified: "2026-01-01T00:00:00.000Z", locked: false };
  expect(notes.pick([old, ...listed(2)], { sent: {} }, { now }).send.map((n) => n.id)).toEqual(["n1", "n2"]);
  expect(notes.pick([old], { sent: {} }, { now, since: "2025-12-01T00:00:00.000Z" }).send.length).toBe(1);
  // An edited note is sent again only when asked.
  const edited = [{ ...listed(1)[0], modified: "2026-11-21T00:00:00.000Z" }], st = { last_sync: "2026-11-20T00:00:00.000Z", sent: { n1: "2026-11-01T00:01:00.000Z" } };
  expect(notes.pick(edited, st, { now }).send.length).toBe(0);
  expect(notes.pick(edited, st, { now, edited: true }).send.length).toBe(1);

  const lines: string[] = []; let calls = 0; const state = { sent: {} };
  const dry = await notes.run(reader(listed(3)), async () => { calls++; }, state, { now, dry: true, log: (s) => lines.push(s) });
  expect(calls).toBe(0); expect(dry.state).toBe(state); expect(dry.would).toBe(3); expect(lines[0]).toContain("would send: Note 1");

  const fail = await notes.run(reader(listed(5)), async () => { if (++calls > 2) throw new Error("Recall answered 503"); }, { sent: {} }, { now });
  expect(fail.sent).toBe(2); expect(fail.error).toContain("503"); expect(Object.keys(fail.state.sent)).toEqual(["n1", "n2"]);
  expect(fail.state.last_sync).toBe(listed(2)[1].modified);
});
