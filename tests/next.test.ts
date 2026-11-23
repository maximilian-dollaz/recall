// Agents, Create, Sparks and Remind-an-asset: the rules that must hold whatever the model says.
// Everything runs in temp folders; no model and no network are called (the model is a stub).

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recall-next-test-"));
process.env.RECALL_DATA = ROOT;
mkdirSync(join(ROOT, "library"), { recursive: true });

const agents = await import("../app/agents.ts");
const remind = await import("../app/remind.ts");
const sparks = await import("../app/sparks.ts");
const create = await import("../app/create.ts");
const projects = await import("../app/projects.ts");
const { parseWhen } = await import("../app/reminders.ts");

let n = 0;
const person = () => { const dir = join(ROOT, "libraries", `p${++n}`); mkdirSync(dir, { recursive: true }); return { id: `p${n}`, name: "Tester", email: `p${n}@example.com`, source: `p${n}`, dir }; };
const reply = (o: unknown) => async () => ({ text: JSON.stringify(o), sources: [{ title: "A source", url: "https://example.com/a" }] });
const quiet = <T>(fn: () => Promise<T>) => { const e = console.error, l = console.log; console.error = console.log = () => {}; return fn().finally(() => { console.error = e; console.log = l; }); };

test("an agent run stops at the judgment point, then carries on from the answer", () => quiet(async () => {
  const p = person();
  const run = (await agents.create(p.dir, { directive: "Host a monthly sound bath night" }))!;
  expect(run.status).toBe("queued");
  const r1 = (await agents.work(p, run.id, { think: reply({ title: "Sound bath night", steps: [{ kind: "research", title: "What it costs", text: "About $30 a ticket." }, { kind: "draft", title: "Note", text: "Hi, would you lead it?", to: "a sound healer" }], summary: "Sized up.", ask: { question: "Who leads it?", options: ["I do", "Hire someone"] }, done: false }) }))!;
  expect(r1.status).toBe("needs-you"); expect(r1.steps.length).toBe(2); expect(r1.ask?.options).toEqual(["I do", "Hire someone"]); expect(r1.sources.length).toBe(1);
  expect(agents.list(p.dir).waiting).toBe(1);
  expect(await agents.work(p, run.id, { think: reply({}) })).toBeNull(); // not queued: nothing runs while it waits on the person
  const a = (await agents.answer(p.dir, run.id, "Hire someone"))!;
  expect(a.status).toBe("queued"); expect(a.ask).toBeUndefined();
  const r2 = (await agents.work(p, run.id, { think: reply({ steps: [{ kind: "plan", title: "Next", text: "1. Ask two healers." }], summary: "Done.", ask: null, done: true }) }))!;
  expect(r2.status).toBe("done"); expect(r2.steps.length).toBe(3); expect(r2.answers[0].answer).toBe("Hire someone");
}));

test("what the model returns is checked: unknown step kinds dropped, a question needs two real options", () => {
  const p = agents.parse(JSON.stringify({ steps: [{ kind: "send_email", text: "x" }, { kind: "plan", title: "t", text: "ok" }, { kind: "draft", text: "" }], ask: { question: "Yes?", options: ["only one"] } }), 1)!;
  expect(p.steps.map((s) => s.kind)).toEqual(["plan"]); expect(p.ask).toBeUndefined(); expect(p.done).toBe(true);
  expect(agents.parse("not json at all", 1)).toBeNull();
  expect(agents.parse('Here you go: {"steps":[{"kind":"research","title":"a","text":"b"}],"ask":null}', 1)!.steps.length).toBe(1);
});

test("a run that can't be read fails and can be tried again; a stopped run stays stopped", () => quiet(async () => {
  const p = person();
  const run = (await agents.create(p.dir, { directive: "Look into a kite day" }))!;
  expect((await agents.work(p, run.id, { think: async () => ({ text: "sorry", sources: [] }) }))!.status).toBe("failed");
  expect((await agents.retry(p.dir, run.id))!.status).toBe("queued");
  const slow = agents.work(p, run.id, { think: async () => { await agents.close(p.dir, run.id, "stopped"); return { text: JSON.stringify({ steps: [{ kind: "plan", title: "t", text: "x" }], ask: null }), sources: [] }; } });
  await slow;
  const after = agents.ledger(p.dir).runs[0];
  expect(after.status).toBe("stopped"); expect(after.steps.length).toBe(0);
}));

test("the last round always finishes, even if the model asks again", () => quiet(async () => {
  const p = person();
  const run = (await agents.create(p.dir, { directive: "Plan the retreat" }))!;
  const asks = reply({ steps: [{ kind: "plan", title: "t", text: "x" }], ask: { question: "Which?", options: ["A", "B"] } });
  for (let i = 0; i < agents.MAX_ROUNDS; i++) { const r = (await agents.work(p, run.id, { think: asks }))!; if (r.status === "needs-you") await agents.answer(p.dir, run.id, "A"); }
  const end = agents.ledger(p.dir).runs[0];
  expect(end.status).toBe("done"); expect(end.round).toBe(agents.MAX_ROUNDS);
}));

test("agents that start on their own are capped per day, start once per source, and stop when turned off", async () => {
  const p = person();
  const made = [];
  for (let i = 0; i < agents.AUTO_CAP + 2; i++) made.push(await agents.create(p.dir, { directive: `Idea number ${i}`, from: { kind: "spark", id: `s${i}` }, auto: true }));
  expect(made.filter(Boolean).length).toBe(agents.AUTO_CAP);
  expect(await agents.create(p.dir, { directive: "Asked for by hand", from: { kind: "said" } })).not.toBeNull(); // asking is never capped
  const q = person();
  expect(await agents.create(q.dir, { directive: "Idea one", from: { kind: "piece", id: "x" }, auto: true })).not.toBeNull();
  expect(await agents.create(q.dir, { directive: "Idea one, reworded", from: { kind: "piece", id: "x" }, auto: true })).toBeNull();
  await agents.setAuto(q.dir, false);
  expect(await agents.create(q.dir, { directive: "Another idea", from: { kind: "piece", id: "y" }, auto: true })).toBeNull();
});

test("the same directive handed over twice is one run", async () => {
  const p = person();
  const a = await agents.create(p.dir, { directive: "Find a venue for the lantern festival" });
  const b = await agents.create(p.dir, { directive: "Find a venue for the lantern festival" });
  expect(b!.id).toBe(a!.id); expect(agents.ledger(p.dir).runs.length).toBe(1);
});

test("an asset goes into Remind with the person's words, first back on the day they said", async () => {
  const p = person();
  const items = [{ id: "inspiration/pillow", title: "The pillow", saved: "2026-10-01", thumb: "libraries/x/files/a/p.jpg" }, { id: "inspiration/lamp", title: "The lamp", saved: "2026-10-02" }];
  const made = await remind.addAssets(p.dir, items, "Look at these next Friday before the design call", (s) => parseWhen(s));
  expect(made.length).toBe(1); expect(made[0].kind).toBe("asset"); expect(made[0].title).toBe("The pillow and 1 more"); expect(made[0].thumb).toBe("libraries/x/files/a/p.jpg");
  expect(made[0].words).toBe("Look at these next Friday before the design call");
  expect(new Date(made[0].next).getTime()).toBeGreaterThan(Date.now());
  expect((await remind.addAssets(p.dir, items, "Look at these next Friday before the design call", (s) => parseWhen(s))).length).toBe(0); // the same note on the same asset: once
  expect((await remind.addAssets(p.dir, items, "", (s) => parseWhen(s))).length).toBe(0); // no note, no reminder
});

const page = (dir: string, slug: string, fm: string, body: string) => { const f = join(dir, `${slug}.md`); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, `---\n${fm}\n---\n\n${body}\n`); };

test("sparks: older notes are read once, oldest first, and stop when turned off", () => quiet(async () => {
  const p = person(); const long = "I noticed that when I speak up in a group everyone relaxes. ".repeat(12);
  page(p.dir, "inspiration/2024-01-01-old-note", "title: Old note\ntype: note\nsaved: 2024-01-01", long);
  page(p.dir, "inspiration/2025-06-01-newer-note", "title: Newer note\ntype: note\nsaved: 2025-06-01", long.replace(/speak up/g, "slow down"));
  page(p.dir, "inspiration/2025-07-01-short", "title: Short\ntype: note\nsaved: 2025-07-01", "Too short to hold anything.");
  page(p.dir, "inspiration/2025-08-01-a-piece", "title: A piece\ntype: note\nsaved: 2025-08-01\ntags: [piece]", long);
  projects.invalidate(p.dir);
  expect(sparks.candidates(p.dir).map((c) => c.id)).toEqual(["inspiration/2024-01-01-old-note", "inspiration/2025-06-01-newer-note", "inspiration/2025-07-01-short"]);
  const seen: string[] = [];
  const find = async (text: string, title: string) => { seen.push(title); return [{ words: text.slice(0, 58).trim(), title: `From ${title}`, kind: "realization" }]; };
  expect(await sparks.tick(p, find)).toBe(2); // the short page is marked read without asking the model
  expect(seen).toEqual(["Old note", "Newer note"]);
  expect(sparks.status(p.dir)).toMatchObject({ read: 3, total: 3, found: 2 });
  expect(await sparks.tick(p, find)).toBe(0); expect(seen.length).toBe(2);
  expect(remind.ledger(p.dir).sparks.map((s) => s.from.slug)).toEqual(["inspiration/2024-01-01-old-note", "inspiration/2025-06-01-newer-note"]);
  const q = person(); page(q.dir, "inspiration/2024-01-01-n", "title: N\ntype: note\nsaved: 2024-01-01", long); projects.invalidate(q.dir);
  await sparks.setOn(q.dir, false); expect(await sparks.tick(q, find)).toBe(0);
}));

test("create: a format that the picked items can't make says so; made files are only served to their owner", async () => {
  const p = person();
  page(p.dir, "inspiration/2026-01-01-a-note", "title: A note\ntype: note\nsaved: 2026-01-01", "Just words.");
  projects.invalidate(p.dir);
  const base = { project: "x", projectName: "X", brief: "why", items: ["inspiration/2026-01-01-a-note"] };
  expect(await create.add(p, { ...base, format: "reel" })).toEqual({ error: "A reel needs a video. Pick one you saved." });
  expect(await create.add(p, { ...base, format: "board-video" })).toEqual({ error: "That needs pictures. Pick at least one." });
  expect(await create.add(p, { ...base, items: ["nope"], format: "post" })).toEqual({ error: "Pick something first." });
  expect(await create.add(p, { ...base, format: "gif" as any })).toEqual({ error: "Pick what to make." });
  expect(create.made(p, "missing", 0)).toBeNull();
  expect(existsSync(join(p.dir, "created"))).toBe(false);
});
