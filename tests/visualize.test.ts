process.env.HIGGSFIELD_BIN = "off"; // tests never use the real Higgsfield sign-in
process.env.OPENAI_KEY_FILE = "/nonexistent/openai.key"; // tests never use a real OpenAI key
// Visualize: canvas operations, version conflicts, the spend cap, prompt building and dry mode.
// Runs against a scratch RECALL_DATA folder with a fake Higgsfield; nothing here touches the real library or the network.
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "recall-viz-"));
process.env.RECALL_DATA = ROOT; // before the import: paths.ts reads it once
const V = await import("../app/visualize.ts");

const KEY_FILE = join(ROOT, "hf.key");
const KEY = "kid123:ksecret456";
const BUDGET = join(ROOT, "library/visualize-budget.json");
const person = { id: "max", name: "Max", email: "max@example.com", source: "default", dir: join(ROOT, "library") };
const pat = { ...person, id: "pat", name: "Pat", email: "pat@example.com" };
// A 1×1 PNG, enough for sips.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const info = (n: number, file = true) => ({ item: `max:inspiration/2026-11-02-thing-${n}`, person: "max", title: `Thing ${n}`, kind: "image", summary: `A red velvet chair number ${n}.`, notes: "for the back wall", description: "A deep red velvet armchair under warm light.", file: file ? `library/files/x/pic-${n}.png` : undefined, by: "Max" });

function make(over: Partial<Parameters<typeof V.createVisualize>[0]> = {}) {
  const saves: any[] = [], calls: { url: string; init: any }[] = [];
  const v = V.createVisualize({
    queueSave: async (p, input) => { saves.push({ p: p.id, ...input }); return { id: "2026-11-03-saved1" }; },
    canSee: (_p, b) => b === "default",
    resolveItem: async (_p, id) => id.startsWith("nope") ? null : info(Number(id.replace(/\D/g, "")) || 1),
    chat: async () => { throw new Error("model down"); },
    fetch: (async (url: string, init: any) => { calls.push({ url: String(url), init }); throw new Error("no network in tests"); }) as any,
    keyFile: KEY_FILE,
    ...over,
  });
  return { v, saves, calls };
}
const settle = async (v: any, board = "default", ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await v.ops.state(person, board); if (!s.jobs.some((j: any) => j.status === "drafting")) return s; await Bun.sleep(50); }
  throw new Error("job never left drafting");
};

beforeEach(() => {
  rmSync(join(ROOT, "library"), { recursive: true, force: true });
  rmSync(KEY_FILE, { force: true });
  mkdirSync(join(ROOT, "library/files/x"), { recursive: true });
  for (let i = 1; i <= 6; i++) writeFileSync(join(ROOT, `library/files/x/pic-${i}.png`), PNG);
});

// ── Canvas operations ──
test("operations append, dedupe and bump the version", () => {
  const c = V.freshCanvas("default");
  const a = V.opAddRef(c, info(1), "Max", "t1");
  const again = V.opAddRef(c, info(1), "Pat", "t2");
  expect(again.id).toBe(a.id); expect(c.version).toBe(1); // the same picture twice is once, no change
  V.opAddWords(c, "  carpets   red ", "Max", "t3");
  V.opAddWords(c, "walls concrete", "Pat", "t4");
  expect(c.words.map((w) => w.text)).toEqual(["carpets red", "walls concrete"]);
  expect(() => V.opAddWords(c, "   ", "Max", "t5")).toThrow(V.VizError);
  V.opRemoveRef(c, a.id, "Pat", "t6");
  expect(c.refs[0].removed).toBe("t6"); // a tombstone, the list stays append-only
  expect(() => V.opRemoveRef(c, a.id, "Pat", "t7")).toThrow("already gone");
  expect(c.version).toBe(4);
});

test("state answers 204 (null) when nothing changed, and hides removed refs", async () => {
  const { v } = make();
  await v.ops.addRef(person, "default", "max:1");
  const r2 = await v.ops.addRef(pat, "default", "max:2");
  const s = await v.ops.state(person, "default");
  expect(s.version).toBe(2); expect(s.refs.length).toBe(2);
  expect(s.refs[1].addedBy).toBe("Pat"); expect(s.refs[0].picture).toBe(true);
  expect(await v.ops.state(person, "default", 2)).toBeNull();
  await v.ops.removeRef(person, "default", r2.id);
  const s2 = await v.ops.state(person, "default", 2);
  expect(s2.version).toBe(3); expect(s2.refs.map((r: any) => r.id)).not.toContain(r2.id);
  expect(JSON.stringify(s2)).not.toContain("library/files"); // file paths stay on the server
});

test("a board you can't see, a bad board id, a private item", async () => {
  const { v } = make();
  await expect(v.ops.state(person, "other")).rejects.toMatchObject({ status: 403 });
  await expect(v.ops.state(person, "../x")).rejects.toMatchObject({ status: 400 });
  await expect(v.ops.addRef(person, "default", "nope:1")).rejects.toMatchObject({ status: 404 });
});

test("the default lookup refuses private saves and unfiled ones without reading anything", async () => {
  expect(await V.resolveFromLibrary(person, "vault:2026-11-02-abc")).toBeNull();
  expect(await V.resolveFromLibrary(person, "pending:2026-11-02-abc")).toBeNull();
  expect(await V.resolveFromLibrary(person, "soul/rules")).toBeNull();
});

// ── Version conflicts ──
test("setPrompt with a stale version is a 409; many people at once never lose words", async () => {
  const { v } = make();
  const first = await v.ops.setPrompt(person, "default", "a red room", "", 0);
  expect(first.version).toBe(1);
  await expect(v.ops.setPrompt(pat, "default", "a blue room", "", 0)).rejects.toMatchObject({ status: 409 });
  // Two editors on the same version at the same moment: exactly one wins.
  const both = await Promise.allSettled([v.ops.setPrompt(person, "default", "x", "", 1), v.ops.setPrompt(pat, "default", "y", "", 1)]);
  expect(both.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect(both.filter((r) => r.status === "rejected").length).toBe(1);
  // Twenty people talking at once: all twenty land, each a version.
  const before = (await v.ops.state(person, "default")).version;
  await Promise.all(Array.from({ length: 20 }, (_, i) => v.ops.addWords(i % 2 ? pat : person, "default", `idea ${i}`)));
  const s = await v.ops.state(person, "default");
  expect(s.words.length).toBe(20); expect(s.version).toBe(before + 20);
});

// ── Budget and cap ──
test("spendBlocked: off at 0, refuses no price, refuses over the cap counting reservations", () => {
  const b = { capUsd: 0, spentUsd: 0, reserved: {}, privacyOk: true };
  expect(V.spendBlocked(b, 0.1)).toContain("switched off");
  const on = { capUsd: 5, spentUsd: 3, reserved: { a: 1 }, privacyOk: true };
  expect(V.spendBlocked(on, NaN)).toContain("No price");
  expect(V.spendBlocked(on, 1)).toBeNull(); // 3 + 1 + 1 = 5, exactly the cap
  expect(V.spendBlocked(on, 1.01)).toContain("$5");
});

test("reserve, then settle: done counts as spent, failed is released, over the cap is 402", async () => {
  writeFileSync(BUDGET, JSON.stringify({ capUsd: 2, spentUsd: 0, reserved: {}, privacyOk: true }));
  await V.reserve("j1", 0.75); await V.reserve("j2", 0.75);
  await expect(V.reserve("j3", 0.75)).rejects.toMatchObject({ status: 402 });
  await V.settle("j1", true); await V.settle("j2", false);
  const b = JSON.parse(readFileSync(BUDGET, "utf8"));
  expect(b.spentUsd).toBe(0.75); expect(b.reserved).toEqual({});
});

test("limits: two running at once, then 429", async () => {
  const { v } = make({ chat: () => new Promise(() => {}) }); // a model that never answers keeps jobs drafting
  await v.ops.addWords(person, "default", "warm light");
  await v.ops.generate(person, "default", "image"); await v.ops.generate(person, "default", "image");
  await expect(v.ops.generate(person, "default", "image")).rejects.toMatchObject({ status: 429 });
});

test("thirty an hour per board", () => {
  const c = V.freshCanvas("default"); const now = Date.parse("2026-11-03T10:00:00Z");
  c.words.push({ id: "w", by: "Max", text: "x", at: "" });
  for (let i = 0; i < 30; i++) c.jobs.push({ id: `j${i}`, status: "completed", created: new Date(now - 60_000).toISOString() } as any);
  expect(() => V.opGenerate(c, { id: "n", kind: "image", mode: "dry", model: "m", estimateUsd: 0, by: "Max", created: "" }, now)).toThrow("30");
  expect(() => V.opGenerate(c, { id: "n", kind: "image", mode: "dry", model: "m", estimateUsd: 0, by: "Max", created: "" }, now + 3_600_000)).not.toThrow();
});

// ── Prompt building ──
test("fallback joins the pieces in order; later words come after the previous prompt", async () => {
  const c = V.freshCanvas("default");
  V.opAddRef(c, info(1), "Max", "t");
  V.opAddWords(c, "carpets red", "Max", "t"); V.opAddWords(c, "walls concrete", "Pat", "t");
  const d = await V.draftPrompt(c, "image", async () => { throw new Error("down"); });
  expect(d.drafted).toBe(false);
  expect(d.prompt.indexOf("carpets red")).toBeLessThan(d.prompt.indexOf("walls concrete"));
  expect(d.prompt).toContain("Thing 1");
  V.opSetPrompt(c, { text: d.prompt, baseVersion: 0 }, "Max", "t");
  V.opAddWords(c, "lights dimmer and more yellow", "Lee", "t");
  const again = V.fallbackPrompt(c, "image");
  expect(again.prompt.startsWith(d.prompt.replace(/\.$/, ""))).toBe(true);
  expect(again.prompt).toContain("Now: lights dimmer and more yellow.");
  expect(again.prompt.split("Now:")[1]).not.toContain("carpets red"); // only what's new since the last prompt
  expect(V.capWords(Array(300).fill("w").join(" ")).split(" ").length).toBe(120);
});

test("the model's draft is used when it answers JSON, and sees who said what and the old prompt", async () => {
  const c = V.freshCanvas("default");
  V.opAddWords(c, "carpets red", "Max", "t");
  V.opSetPrompt(c, { text: "a quiet lounge", baseVersion: 0 }, "Max", "t");
  let seen = "";
  const d = await V.draftPrompt(c, "image", async (m) => { seen = m[0].content; return JSON.stringify({ prompt: "A quiet lounge with red carpets and warm light", negative: "text, watermark" }); });
  expect(d).toEqual({ prompt: "A quiet lounge with red carpets and warm light", negative: "text, watermark", drafted: true });
  expect(seen).toContain("- Max: carpets red"); expect(seen).toContain("a quiet lounge");
  const bad = await V.draftPrompt(c, "image", async () => "not json");
  expect(bad.drafted).toBe(false);
});

// ── Dry mode ──
test("dry mode: no key means nothing leaves; a labelled contact sheet comes back", async () => {
  const { v, calls } = make();
  await v.ops.addRef(person, "default", "max:1"); await v.ops.addRef(person, "default", "max:2");
  await v.ops.addWords(pat, "default", "carpets red");
  const job = await v.ops.generate(person, "default", "image");
  expect(job.mode).toBe("dry"); expect(job.status).toBe("drafting");
  const s = await settle(v);
  const done = s.jobs[0];
  expect(s.mode).toBe("dry"); expect(s.why).toContain("no key");
  expect(done.status).toBe("preview"); expect(done.files[0]).toMatch(/-preview\.svg$/);
  const svg = readFileSync(join(ROOT, "library/boards/default/generated", done.files[0]), "utf8");
  expect(svg).toContain("PREVIEW · nothing was sent out");
  expect(svg).toContain("carpets red"); expect(svg).toContain("data:image/jpeg;base64,");
  expect(s.prompt.text).toBe(done.prompt); // the shared prompt follows the draft
  expect(calls.length).toBe(0); // not one request
  expect(existsSync(BUDGET)).toBe(false); // dry mode writes no budget
});

test("dry even with a key and a cap, until the privacy wording is approved", async () => {
  writeFileSync(KEY_FILE, KEY);
  writeFileSync(BUDGET, JSON.stringify({ capUsd: 10, spentUsd: 0, reserved: {}, privacyOk: false }));
  const { v, calls } = make();
  await v.ops.addRef(person, "default", "max:1");
  const job = await v.ops.generate(person, "default", "video");
  expect(job.mode).toBe("dry"); expect(job.source).toBeTruthy();
  const s = await settle(v); expect(s.jobs[0].status).toBe("preview"); expect(s.why).toEqual(["privacy wording not approved"]);
  expect(calls.length).toBe(0);
});

test("a video needs a picture; an empty canvas makes nothing", async () => {
  const { v } = make({ resolveItem: async () => info(1, false) });
  await expect(v.ops.generate(person, "default", "image")).rejects.toMatchObject({ status: 400 });
  await v.ops.addRef(person, "default", "max:1");
  await expect(v.ops.generate(person, "default", "video")).rejects.toMatchObject({ status: 400 });
});

test("keep: a normal save with the prompt and where it came from", async () => {
  const { v, saves } = make();
  await v.ops.addRef(person, "default", "max:1"); await v.ops.addWords(pat, "default", "walls concrete");
  await v.ops.generate(person, "default", "image"); const s = await settle(v);
  await expect(v.ops.keep(pat, "default", s.jobs[0].id, s.jobs[0].files[0], "")).rejects.toMatchObject({ status: 400 });
  await expect(v.ops.keep(pat, "default", s.jobs[0].id, "../../x.svg", "zero-proof-lounge")).rejects.toMatchObject({ status: 404 });
  const r = await v.ops.keep(pat, "default", s.jobs[0].id, s.jobs[0].files[0], "zero-proof-lounge");
  expect(r.save).toBe("2026-11-03-saved1");
  expect(saves[0].p).toBe("pat"); expect(saves[0].project).toBe("zero-proof-lounge");
  expect(saves[0].notes).toContain(s.jobs[0].prompt);
  expect(saves[0].notes).toContain('Preview made in Recall (nothing was sent out) from "Thing 1" (Max), with words by Pat.');
  expect(existsSync(saves[0].files[0])).toBe(true);
  expect((await v.ops.state(person, "default")).kept[0]).toMatchObject({ by: "Pat", project: "zero-proof-lounge" });
});

// ── Live, against a fake Higgsfield ──
function fakeHiggsfield(opts: { usd?: string; fail?: string } = {}) {
  const calls: { url: string; method: string; auth: string | null; body?: any }[] = [];
  let polls = 0;
  const f = async (url: string, init: any = {}) => {
    const h = new Headers(init.headers); const method = init.method ?? "GET";
    calls.push({ url, method, auth: h.get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.higgsfield.ai/estimate/")) return J({ usd: opts.usd ?? "0.10" });
    if (url === "https://api.higgsfield.ai/files/generate-upload-url") return J({ upload_url: "https://storage.example.com/put?sig=1", public_url: "https://cdn.example.com/in.png", content_type: "image/png", upload_headers: { "Content-Type": "image/png", "x-amz-tagging": "t=1" } });
    if (url.startsWith("https://storage.example.com/")) return new Response("", { status: 200 });
    if (url.endsWith("/status")) { polls++; return J(opts.fail ? { status: opts.fail, error: `bad ${KEY}` } : polls < 2 ? { status: "in_progress" } : { status: "completed", images: [{ url: "https://cdn.example.com/out.png" }], video: url.includes("vid") ? { url: "https://cdn.example.com/out.mp4" } : undefined }); }
    if (url.startsWith("https://cdn.example.com/out")) return new Response(PNG, { headers: { "content-type": url.endsWith(".mp4") ? "video/mp4" : "image/png" } });
    if (url.startsWith("https://api.higgsfield.ai/")) return J({ status: "queued", request_id: body(init).image_url ? "vid1" : "req1", status_url: `https://api.higgsfield.ai/requests/${body(init).image_url ? "vid1" : "req1"}/status` });
    return new Response("nope", { status: 404 });
  };
  const body = (init: any) => { try { return JSON.parse(init.body); } catch { return {}; } };
  return { f: f as any, calls };
}
const goLive = (cap = 5) => { writeFileSync(KEY_FILE, KEY); writeFileSync(BUDGET, JSON.stringify({ capUsd: cap, spentUsd: 0, reserved: {}, privacyOk: true })); };

test("live: estimate, reserve, submit, poll, download, spend; the key goes only to Higgsfield", async () => {
  goLive();
  const hf = fakeHiggsfield();
  const { v } = make({ fetch: hf.f, chat: async () => JSON.stringify({ prompt: "A lounge with red velvet chairs and concrete walls", negative: "text" }) });
  await v.ops.addRef(person, "default", "max:1"); await v.ops.addWords(person, "default", "red chairs");
  const job = await v.ops.generate(person, "default", "image");
  expect(job.mode).toBe("live"); expect(job.estimateUsd).toBe(0.1);
  expect(JSON.parse(readFileSync(BUDGET, "utf8")).reserved[job.id]).toBe(0.1);
  await settle(v);
  let s = await v.ops.state(person, "default"); expect(s.jobs[0].status).toBe("queued");
  expect(v.open.size).toBe(1);
  await v.pollOnce(); s = await v.ops.state(person, "default"); expect(s.jobs[0].status).toBe("in_progress");
  await v.pollOnce(); s = await v.ops.state(person, "default");
  expect(s.jobs[0].status).toBe("completed"); expect(s.jobs[0].files).toEqual([`${job.id}-1.png`]);
  expect(existsSync(join(ROOT, "library/boards/default/generated", `${job.id}-1.png`))).toBe(true);
  const b = JSON.parse(readFileSync(BUDGET, "utf8")); expect(b.spentUsd).toBe(0.1); expect(b.reserved).toEqual({});
  const submit = hf.calls.find((c) => c.url === "https://api.higgsfield.ai/higgsfield-ai/soul/standard")!;
  expect(submit.body).toMatchObject({ prompt: "A lounge with red velvet chairs and concrete walls", aspect_ratio: "16:9" });
  for (const c of hf.calls) expect(c.auth === `Key ${KEY}`).toBe(c.url.startsWith("https://api.higgsfield.ai/"));
  expect(JSON.stringify(s)).not.toContain(KEY.split(":")[1]); expect(JSON.stringify(s)).not.toContain("status_url");
});

test("live video: the picture is uploaded first and goes in as image_url", async () => {
  goLive();
  const hf = fakeHiggsfield();
  const { v } = make({ fetch: hf.f });
  await v.ops.addRef(person, "default", "max:1");
  await v.ops.generate(person, "default", "video"); await settle(v);
  const put = hf.calls.find((c) => c.url.startsWith("https://storage.example.com/"))!;
  expect(put.method).toBe("PUT"); expect(put.auth).toBeNull();
  const submit = hf.calls.find((c) => c.url === "https://api.higgsfield.ai/kling-video/v2.5-turbo/standard/image-to-video")!;
  expect(submit.body).toMatchObject({ image_url: "https://cdn.example.com/in.png", duration: 5 });
  await v.pollOnce(); await v.pollOnce();
  const s = await v.ops.state(person, "default"); expect(s.jobs[0].status).toBe("completed");
  expect(s.jobs[0].files.some((f: string) => f.endsWith(".mp4"))).toBe(true);
});

test("live: over the cap is 402 and nothing is sent", async () => {
  goLive(0.05);
  const hf = fakeHiggsfield({ usd: "0.10" });
  const { v } = make({ fetch: hf.f });
  await v.ops.addWords(person, "default", "warm light");
  await expect(v.ops.generate(person, "default", "image")).rejects.toMatchObject({ status: 402 });
  expect(hf.calls.filter((c) => !c.url.includes("/estimate/")).length).toBe(0);
  expect((await v.ops.state(person, "default")).jobs.length).toBe(0);
});

test("live: a failed job releases its money, and the key never reaches the error", async () => {
  goLive();
  const hf = fakeHiggsfield({ fail: "failed" });
  const { v } = make({ fetch: hf.f });
  await v.ops.addWords(person, "default", "warm light");
  await v.ops.generate(person, "default", "image"); await settle(v); await v.pollOnce();
  const s = await v.ops.state(person, "default");
  expect(s.jobs[0].status).toBe("failed"); expect(s.jobs[0].error).not.toContain("ksecret456"); expect(s.jobs[0].error).toContain("[key]");
  const b = JSON.parse(readFileSync(BUDGET, "utf8")); expect(b.spentUsd).toBe(0); expect(b.reserved).toEqual({});
});

test("Create picks the model: GPT Image for words and logos or by default, Nano Banana Pro for several photos, Max's choice wins", () => {
  const c = V.freshCanvas("t"), at = "2026-11-03T00:00:00.000Z";
  const pic = (id: string) => V.opAddRef(c, { item: id, person: "max", title: id, kind: "image", summary: "", notes: "", description: "", file: `library/files/${id}.jpg`, by: "Max" }, "Max", at);
  expect(V.pickModel(c).label).toBe("GPT Image 2.5");
  pic("a"); pic("b");
  expect(V.pickModel(c).label).toBe("Nano Banana Pro");
  V.opAddWords(c, "put the Zero Proof logo on the wall", "Max", at);
  expect(V.pickModel(c).label).toBe("GPT Image 2.5");
  expect(V.pickModel(c, "flux").label).toBe("FLUX 3");
});

test("Create: changing the last picture keeps the model that made it", () => {
  const c = V.freshCanvas("t"), at = "2026-11-03T00:00:00.000Z";
  V.opAddWords(c, "a lounge bar", "Max", "2026-11-02T23:00:00.000Z"); // what made the picture, still in the panel
  c.jobs.push({ id: "j1", kind: "image", mode: "live", model: "hfcli/nano_banana_2", status: "completed", files: ["j1-1.png"], estimateUsd: 0, by: "Max", created: at, updated: at, prompt: "a sign", negative: "", drafted: true, refs: [] } as any);
  V.opAddWords(c, "make the shelves brass", "Max", "2026-11-03T00:05:00.000Z");
  expect(V.pickModel(c, undefined, true).label).toBe("Nano Banana Pro");
  expect(V.pickModel(c, undefined, false).label).toBe("GPT Image 2.5");
});

test("Create: after Start over, the next picture starts fresh instead of changing the old one", () => {
  const c = V.freshCanvas("t");
  c.jobs.push({ id: "j1", kind: "image", mode: "live", model: "hfcli/gpt_image_2_5", status: "completed", files: ["j1-1.png"], estimateUsd: 0, by: "Max", created: "2026-11-03T00:00:00.000Z", updated: "2026-11-03T00:00:00.000Z", prompt: "", negative: "", drafted: true, refs: [] } as any);
  V.opAddWords(c, "a new idea", "Max", "2026-11-03T01:00:00.000Z");
  expect(V.lastPicture(c, { id: "j2", created: "2026-11-03T01:01:00.000Z" })).toBeUndefined();
});

test("Create: Clear empties the panel (pictures in, words, made pictures) and the next picture starts fresh", () => {
  const c = V.freshCanvas("t"), at = "2026-11-03T00:00:00.000Z";
  V.opAddRef(c, { item: "a", person: "max", title: "a", kind: "image", summary: "", notes: "", description: "", file: "library/files/a.jpg", by: "Max" }, "Max", at);
  V.opAddWords(c, "a lounge bar", "Max", at);
  c.jobs.push({ id: "j1", kind: "image", mode: "live", model: "hfcli/gpt_image_2_5", status: "completed", files: ["j1-1.png"], estimateUsd: 0, by: "Max", created: "2026-11-03T00:01:00.000Z", updated: at, prompt: "", negative: "", drafted: true, refs: [] } as any);
  V.opClear(c, "Max", "2026-11-03T00:02:00.000Z");
  expect(V.basisOf(c)).toEqual({ refs: [], words: [] });
  V.opAddWords(c, "something new", "Max", "2026-11-03T00:03:00.000Z");
  expect(V.lastPicture(c, { id: "j2", created: "2026-11-03T00:04:00.000Z" })).toBeUndefined();
});
