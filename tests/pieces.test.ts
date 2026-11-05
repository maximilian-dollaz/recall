import { test, expect } from "bun:test";
import { split, locate, LONG } from "../app/pieces.ts";

const para = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ") + ".";

test("short text is one window", () => {
  const w = split("one\n\ntwo");
  expect(w.length).toBe(1);
  expect(w[0]).toMatchObject({ start: 0, end: 8 });
});

test("windows cover the whole text, in order, within the size", () => {
  const body = Array.from({ length: 60 }, (_, i) => para(40, `p${i}w`)).join("\n\n");
  const ws = split(body, 2000);
  expect(ws.length).toBeGreaterThan(5);
  for (const w of ws) expect(w.end - w.start).toBeLessThanOrEqual(2000);
  for (let i = 1; i < ws.length; i++) expect(ws[i].start).toBeGreaterThanOrEqual(ws[i - 1].end);
  expect(body.slice(ws[0].start, ws.at(-1)!.end).length).toBeGreaterThan(body.length - 10);
});

test("a transcript with no paragraph breaks is cut at sentence ends", () => {
  const body = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here`).join(". ") + ".";
  const ws = split(body, 3000);
  expect(ws.length).toBeGreaterThan(3);
  for (const w of ws.slice(0, -1)) expect(body[w.end - 1]).toBe(".");
});

test("a heading starts a new window and names it", () => {
  const body = `# Vision\n\n${para(200)}\n\n## The lounge\n\n${para(200)}\n\n${para(200)}`;
  const ws = split(body, 3000);
  expect(ws[0].section).toBe("Vision");
  expect(ws.some((w) => w.section === "The lounge")).toBe(true);
});

test("locate finds a quote word for word, despite case, quotes and spacing", () => {
  const text = "Intro.\n\nWe should put   red carpets in the Zero Proof lounge, and make the lights dimmer.\n\nEnd.";
  expect(locate(text, "we should put red carpets in the \"Zero Proof\" lounge")).toBeGreaterThan(0);
});

test("locate rejects a quote the model made up", () => {
  expect(locate("We talked about the budget for March.", "The team agreed to open a third lounge in Austin next spring")).toBe(-1);
});

test("locate accepts a quote with one word changed in the middle", () => {
  const text = "Our north star is that every person who walks in leaves feeling more like themselves than when they arrived today.";
  expect(locate(text, "Our north star is that every person who walks into the space leaves feeling more like themselves than when they arrived today")).toBeGreaterThanOrEqual(0);
});

test("only long saves get pieces", () => { expect(LONG).toBeGreaterThanOrEqual(6000); });
