// The Home Screen handoff: Safari's sign-in carried once into the Home Screen app. Runs on a throwaway data folder.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "recall-handoff-"));
Bun.env.RECALL_DATA = dir; mkdirSync(join(dir, "library"), { recursive: true });
const door = await import("../app/door.ts");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = (code: string, cookie = "") => door.helloDoor(code, new Request(`http://door/hello/${code}`, { headers: cookie ? { cookie } : {} }));
const sid = (r: Response) => r.headers.get("set-cookie")?.match(/recall_sid=([A-Za-z0-9_-]+)/)?.[1] ?? "";

test("a handoff code signs in one browser, once, as that person", async () => {
  const code = await door.mintHandoff("friend@x.test");
  const first = await open(code);
  expect(first.status).toBe(302); expect(first.headers.get("location")).toBe("/");
  const s = sid(first); expect(s).not.toBe("");
  expect(await door.sessionEmail(new Request("http://door/", { headers: { cookie: `recall_sid=${s}` } }))).toBe("friend@x.test");
  const again = await open(code); // spent: a second browser has to sign in
  expect(again.headers.get("location")).toBe("/signin"); expect(sid(again)).toBe("");
});

test("Safari reloading the page while signed in as that person spends nothing", async () => {
  const code = await door.mintHandoff("pat@x.test");
  const signed = sid(await open(await door.mintHandoff("pat@x.test")));
  const reload = await open(code, `recall_sid=${signed}`);
  expect(reload.headers.get("location")).toBe("/"); expect(sid(reload)).toBe("");
  expect(sid(await open(code))).not.toBe(""); // still good for the Home Screen app
});

test("an unknown code goes to sign-in; the manifest opens the code", async () => {
  expect((await open("x".repeat(32))).headers.get("location")).toBe("/signin");
  const m = await door.helloManifest("abc").json();
  expect(m.start_url).toBe("/hello/abc"); expect(m.display).toBe("standalone");
});
