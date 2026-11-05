// Team boards: migration from team-shares.json, who may see what, invites, and the per-person tree.
// Runs against a throwaway data folder (RECALL_DATA), never anyone's library. `bun test tests/boards.test.ts`
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `bun test` runs every file in one process, so paths.ts may already point at an earlier file's scratch folder:
// then use that one (starting clean). Otherwise make our own. Never anything outside the temp folder.
const temp = (p?: string) => !!p && (p.startsWith(tmpdir()) || p.startsWith("/var/folders/") || p.startsWith("/tmp/"));
let made: string | undefined;
if (!temp(Bun.env.RECALL_DATA)) Bun.env.RECALL_DATA = made = mkdtempSync(join(tmpdir(), "recall-boards-"));
const { DATA: D } = await import("../app/paths.ts");
if (!temp(D)) throw new Error(`refusing to run against ${D}`);
if (D !== made) for (const d of ["library", "libraries"]) rmSync(join(D, d), { recursive: true, force: true });
// The first board's id and name, the same on every machine (a real install sets them in .env).
Bun.env.RECALL_TEAM_ID = "tnm"; Bun.env.RECALL_TEAM_NAME = "Team Board";
Bun.env.OLLAMA_BASE_URL = "http://127.0.0.1:9/v1"; // no local AI: topics fall back to one "Everything" group, fast

const SHARES = { frequency: { max: { since: "2026-11-01T10:00:00.000Z" }, pat: { since: "2026-11-02T09:00:00.000Z" } } };
const PEOPLE = {
  owner: "max@x.test",
  people: {
    "max@x.test": { id: "max", name: "Max", source: "default" },
    "pat@x.test": { id: "pat", name: "Pat", source: "pat" },
    "lee@x.test": { id: "lee", name: "Lee", source: "lee" },
    "eve@x.test": { id: "eve", name: "Eve", source: "eve" },
    "max3@x.test": { id: "max-3", name: "Max", source: "max-3" },
  },
};
const CATALOG = { version: 1, shelves: [], proposed: [], corrections: [], projects: [
  { id: "frequency", name: "Frequency Wellness Lounge", aliases: ["Frequency"], team: true },
  { id: "zero-proof", name: "Zero Proof Lounge", aliases: [], team: true },
  { id: "lees-zero", name: "Lees Zero", aliases: [] },
  { id: "secret", name: "Secret", aliases: [] },
] };
const write = (rel: string, data: unknown) => { mkdirSync(join(D, rel, ".."), { recursive: true }); writeFileSync(join(D, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2)); };
const pageAt = (lib: string, slug: string, project: string, file: string) => {
  write(`${lib}/files/${slug}/1.jpg`, "jpg");
  write(`${lib}/projects/${slug}.md`, `---\ntitle: "${slug}"\nkind: image\nproject: ${project}\nsaved: 2026-11-02\nfiles: ["${file}"]\ntags: []\n---\n\n> ${slug}\n`);
};

let boards: typeof import("../app/board.ts");
let identity: typeof import("../app/identity.ts");
let routes: ReturnType<typeof import("../app/boards-routes.ts").boardRoutes>;
let boardDoor: typeof import("../app/boards-routes.ts").boardDoor;
let google: typeof import("../app/google.ts");
let catalog: any;

beforeAll(async () => {
  write("library/people.json", PEOPLE);
  write("library/team-shares.json", SHARES);
  write("library/categories.json", CATALOG);
  pageAt("library", "max-room", "frequency", "library/files/max-room/1.jpg");
  pageAt("library", "max-secret", "secret", "library/files/max-secret/1.jpg");
  pageAt("libraries/pat", "pat-lamp", "frequency", "libraries/pat/files/pat-lamp/1.jpg");
  pageAt("libraries/pat", "pat-bar", "zero-proof", "libraries/pat/files/pat-bar/1.jpg");
  pageAt("libraries/lee", "lee-bar", "lees-zero", "libraries/lee/files/lee-bar/1.jpg");
  pageAt("libraries/eve", "eve-room", "frequency", "libraries/eve/files/eve-room/1.jpg");
  pageAt("libraries/max-3", "max3-chair", "frequency", "libraries/max-3/files/max3-chair/1.jpg");
  boards = await import("../app/board.ts");
  // If another test file loaded paths.ts first, DATA could be the real library: stop before writing anything.
  if (!boards.BOARDS.startsWith(D + "/")) throw new Error(`refusing to run: boards.json would be ${boards.BOARDS}`);
  const projects = await import("../app/projects.ts"); // forget pages an earlier file's run may have cached
  for (const lib of ["library", "libraries/pat", "libraries/lee", "libraries/eve", "libraries/max-3"]) projects.invalidate(join(D, lib));
  boards.invalidate();
  identity = await import("../app/identity.ts");
  google = await import("../app/google.ts");
  const r = await import("../app/boards-routes.ts");
  boardDoor = r.boardDoor;
  // Stand-in for server.ts's withPerson: the test names the person in a header.
  routes = r.boardRoutes((fn) => async (req) => fn(req, (await identity.personById(req.headers.get("x-test-person")!))!));
  catalog = (await import("../app/librarian.ts")).loadCatalog;
});
afterAll(() => { if (made) rmSync(made, { recursive: true, force: true }); });

const call = async (path: string, as: string, init: RequestInit = {}, params: Record<string, string> = {}) => {
  const pattern = path.startsWith("/board/img/") ? "/board/img/*" : path.split("?")[0];
  const route: any = (routes as any)[pattern];
  const h = typeof route === "function" ? route : route[init.method ?? "GET"];
  let url = path; for (const [k, v] of Object.entries(params)) url = url.replace(`:${k}`, v);
  const req: any = new Request(`http://inner${url}`, { ...init, headers: { "x-test-person": as, "content-type": "application/json", ...(init.headers ?? {}) } });
  req.params = params;
  return h(req) as Promise<Response>;
};

// ── Migration ──
test("an unreadable team-shares.json makes no board (never a board that lost every share)", () => {
  write("library/team-shares.json", "{ torn");
  expect(() => boards.ensure()).toThrow();
  expect(existsSync(boards.BOARDS)).toBe(false);
  write("library/team-shares.json", SHARES);
});

test("first load makes one board from team-shares.json, keeping who shared what and since when", () => {
  const before = readFileSync(join(D, "library/team-shares.json"), "utf8");
  const f = boards.load();
  const b = f.boards.tnm;
  expect(f.default).toBe("tnm");
  expect(b.name).toBe("Team Board");
  expect(b.owner).toBe("max");
  expect(b.members.max.role).toBe("owner");
  expect(Object.keys(b.members).sort()).toEqual(["eve", "lee", "max", "max-3", "pat"]);
  expect(b.projects.frequency.shares.pat).toEqual({ since: "2026-11-02T09:00:00.000Z", from: "frequency" });
  expect(b.projects.frequency.added).toBe("2026-11-01T10:00:00.000Z");
  expect(readFileSync(join(D, "library/team-shares.json"), "utf8")).toBe(before); // old file untouched
});

test("migration is idempotent", () => {
  const once = readFileSync(boards.BOARDS, "utf8");
  expect(boards.ensure()).toBe(false);
  expect(readFileSync(boards.BOARDS, "utf8")).toBe(once);
  const at = "2026-11-03T00:00:00.000Z";
  expect(boards.migrate(SHARES, PEOPLE as any, at)).toEqual(boards.migrate(SHARES, PEOPLE as any, at));
});

// ── Access ──
test("only members see a board; only the owner edits it", async () => {
  expect(boards.canSee("pat", "tnm")).toBe(true);
  expect(boards.canEdit("pat", "tnm")).toBe(false);
  expect(boards.canEdit("max", "tnm")).toBe(true);
  const client = await boards.createBoard("Client Work", "pat");
  expect(client.id).toBe("client-work");
  expect(boards.canSee("max", "client-work")).toBe(false);
  expect(boards.canEdit("pat", "client-work")).toBe(true);
  expect((await call("/api/boards/:id", "max", {}, { id: "client-work" })).status).toBe(404);
  expect((await call("/api/boards/:id", "pat", {}, { id: "client-work" })).status).toBe(200);
  const list = await (await call("/api/boards", "max")).json();
  expect(list.boards.map((b: any) => b.id)).toEqual(["tnm"]);
  expect(await boards.removeMember("tnm", "max")).toBe(false); // the owner stays
});

test("a removed member loses the board, the old endpoints, its pictures, and their saves leave it", async () => {
  const before = await boards.teamProject(await catalog(), "frequency");
  expect(before!.items.some((i) => i.id === "eve:projects/eve-room")).toBe(false); // eve never shared frequency
  await boards.setShared("frequency", "eve", true);
  expect((await boards.teamProject(await catalog(), "frequency"))!.items.some((i) => i.id === "eve:projects/eve-room")).toBe(true);
  expect(await boards.removeMember("tnm", "eve")).toBe(true);
  expect(boards.canSee("eve", "tnm")).toBe(false);
  expect((await boards.teamProject(await catalog(), "frequency"))!.items.some((i) => i.id === "eve:projects/eve-room")).toBe(false);
  expect((await (await call("/api/team", "eve")).json()).projects).toEqual([]);
  expect((await call("/api/team/project?id=frequency", "eve")).status).toBe(404);
  expect((await call("/board/zip?project=frequency", "eve")).status).toBe(404);
  expect((await (await call("/api/board?project=frequency", "eve")).json()).cards).toEqual([]);
  expect((await call("/api/team/share", "eve", { method: "POST", body: JSON.stringify({ project: "frequency", on: true }) })).status).toBe(403);
  const img = "/board/img/" + encodeURIComponent("library/files/max-room/1.jpg");
  expect((await call(img, "eve")).status).toBe(404);
  expect(await boards.canFetch(await catalog(), "pat", "library/files/max-room/1.jpg")).toBe(true);
  expect(await boards.canFetch(await catalog(), "pat", "library/files/max-secret/1.jpg")).toBe(false); // not shared
  expect(await boards.canFetch(await catalog(), "pat", "library/files/../people.json")).toBe(false);
});

// ── Invites ──
test("an invite works once, for a week, and is stored hashed", async () => {
  const res = await call("/api/boards/:id/invite", "max", { method: "POST", body: JSON.stringify({ email: "eve@x.test" }) }, { id: "tnm" });
  const inv = await res.json();
  const token = inv.link.split("/b/")[1];
  expect(inv.link).toStartWith("https://");
  expect(inv.mailto).toStartWith("mailto:eve%40x.test?subject=");
  expect(decodeURIComponent(inv.mailto)).toContain(inv.link);
  expect(readFileSync(boards.BOARDS, "utf8")).not.toContain(token);
  expect((await call("/api/boards/:id/invite", "pat", { method: "POST", body: "{}" }, { id: "tnm" })).status).toBe(403); // owner only
  // Not signed in at the door: remember it, then sign in.
  const door = await boardDoor(new Request(`http://door/b/${token}`));
  expect(door!.status).toBe(302);
  expect(door!.headers.get("set-cookie")).toContain(`recall_board=${token}`);
  expect((await boardDoor(new Request(`http://door/b/${"x".repeat(32)}`)))!.status).toBe(404);
  // A GET (link previews) never spends it; the button's POST does.
  expect((await call("/b/:token", "eve", {}, { token })).status).toBe(200);
  expect((await call("/b/:token", "eve", { method: "POST" }, { token })).status).toBe(403); // no x-recall header
  const ok = await (await call("/b/:token", "eve", { method: "POST", headers: { "x-recall": "1" } }, { token })).json();
  expect(ok.board).toBe("tnm");
  expect(boards.canSee("eve", "tnm")).toBe(true);
  expect(await boards.acceptInvite(token, "eve")).toEqual({ board: "tnm", joined: false }); // already in: nothing spent
  expect(await boards.acceptInvite(token, "lee")).toEqual({ board: "tnm", joined: false }); // lee is a member already
  await boards.removeMember("tnm", "lee");
  expect(await boards.acceptInvite(token, "lee")).toBeNull(); // used up
  await boards.addMember("tnm", "lee", "max");
});

test("an expired invite doesn't work", async () => {
  const inv = (await boards.createInvite("client-work", "pat"))!;
  const { update } = await import("../app/store.ts");
  await update<any>(boards.BOARDS, {}, (f) => { for (const i of Object.values<any>(f.boards["client-work"].invites)) i.expires = "2020-01-01T00:00:00.000Z"; });
  expect(boards.inviteInfo(inv.token)).toBeNull();
  expect(await boards.acceptInvite(inv.token, "max")).toBeNull();
  expect(boards.canSee("max", "client-work")).toBe(false);
});

// ── The tree ──
test("an opened project has each person's contribution as its own group, with name, picture and count", async () => {
  write("library/avatars/pat.jpg", "x");
  boards.invalidate();
  const r = (await boards.teamProject(await catalog(), "frequency"))!;
  const by = Object.fromEntries(r.people.map((p) => [p.id, p]));
  expect(r.people.map((p) => p.id)).toEqual(["max", "pat"]); // in the order they shared; eve's share left with her
  expect(by.pat).toMatchObject({ name: "Pat", avatar: "/avatar/pat", count: 1 });
  expect(by.max.avatar).toBeNull(); // no picture: the UI shows initials
  expect(by.max.items.map((i: any) => i.id)).toEqual(["max:projects/max-room"]);
  expect(by.max.groups[0].items).toEqual(["max:projects/max-room"]);
  expect(r.groups.length).toBeGreaterThan(0);
  expect(r.items.some((i) => i.id.includes("max-secret"))).toBe(false);
});

test("someone's own project can feed a board project with another name (from)", async () => {
  const res = await call("/api/boards/:id/share", "lee", { method: "POST", body: JSON.stringify({ project: "zero-proof", from: "lees-zero" }) }, { id: "tnm" });
  expect(res.status).toBe(200);
  const r = (await boards.teamProject(await catalog(), "zero-proof"))!;
  expect(r.people.map((p) => p.id)).toEqual(["lee"]);
  expect(r.items.map((i) => i.id)).toEqual(["lee:projects/lee-bar"]);
  expect(boards.isShared("lees-zero", "lee")).toBe(true);
  await boards.setShared("lees-zero", "lee", false); // stopping from his own project page
  expect(await boards.teamProject(await catalog(), "zero-proof")).toBeNull();
});

test("the autoShareTeamProjects switch puts team projects on the default board for members with items in them", async () => {
  write("library/settings.json", { autoShareTeamProjects: true });
  boards.invalidate();
  const r = (await boards.teamProject(await catalog(), "zero-proof"))!;
  expect(r.items.map((i) => i.id)).toEqual(["pat:projects/pat-bar"]);
  expect(boards.isShared("zero-proof", "pat", await catalog())).toBe(true);
  expect(await boards.teamProject(await catalog(), "zero-proof", "client-work")).toBeNull(); // default board only
  write("library/settings.json", { autoShareTeamProjects: false });
  boards.invalidate();
  expect(await boards.teamProject(await catalog(), "zero-proof")).toBeNull();
});

test("hidden saves leave the board; pins show only while their save is on it", async () => {
  expect((await call("/api/boards/:id/hide", "pat", { method: "POST", body: JSON.stringify({ item: "max:projects/max-room" }) }, { id: "tnm" })).status).toBe(403);
  expect((await call("/api/boards/:id/pin", "pat", { method: "POST", body: JSON.stringify({ item: "max:projects/max-secret" }) }, { id: "tnm" })).status).toBe(404);
  await call("/api/boards/:id/pin", "pat", { method: "POST", body: JSON.stringify({ item: "max:projects/max-room" }) }, { id: "tnm" });
  expect((await boards.boardPins(await catalog())).map((i) => i.id)).toEqual(["max:projects/max-room"]);
  await call("/api/boards/:id/hide", "max", { method: "POST", body: JSON.stringify({ item: "max:projects/max-room" }) }, { id: "tnm" });
  expect((await boards.teamProject(await catalog(), "frequency"))!.items.some((i) => i.id === "max:projects/max-room")).toBe(false);
  expect(await boards.boardPins(await catalog())).toEqual([]);
  await boards.setHidden("tnm", "max:projects/max-room", false);
});

// ── Pictures ──
test("a picture is served only to someone who shares a board with that person", async () => {
  expect((await call("/avatar/:id", "max", {}, { id: "pat" })).status).toBe(200);
  const outsider = await boards.createBoard("Solo", "eve");
  await boards.removeMember("tnm", "eve");
  expect((await call("/avatar/:id", "eve", {}, { id: "pat" })).status).toBe(404);
  expect((await call("/avatar/:id", "max", {}, { id: "max" })).status).toBe(404); // no file: initials
  expect((await call("/avatar/:id", "max", {}, { id: "../people" })).status).toBe(404);
  expect(outsider.owner).toBe("eve");
});

test("only Google's picture host is fetched", () => {
  expect(google.pictureUrl("https://lh3.googleusercontent.com/a/ABC=s96-c")).toBe("https://lh3.googleusercontent.com/a/ABC=s192-c");
  expect(google.pictureUrl("http://lh3.googleusercontent.com/a/ABC")).toBeNull();
  expect(google.pictureUrl("https://googleusercontent.com.evil.test/a")).toBeNull();
  expect(google.pictureUrl("https://evil.test/lh3.googleusercontent.com")).toBeNull();
  expect(google.pictureUrl("https://lh3.googleusercontent.com:8443/a")).toBeNull();
  expect(google.pictureUrl("https://user@lh3.googleusercontent.com/a")).toBeNull();
  expect(google.pictureUrl(undefined)).toBeNull();
});

// ── Several logins, one person ──
test("alias_of: another login opens the main account, and its shares and saves count as that person's", async () => {
  const before = (await boards.teamProject(await catalog(), "frequency"))!.people.map((p) => p.id);
  expect(before).not.toContain("max-3"); // max-3 never shared here (only max and pat in this fixture)
  await boards.setShared("frequency", "max-3", true);
  expect((await boards.teamProject(await catalog(), "frequency"))!.people.map((p) => p.id)).toContain("max-3");
  const { update } = await import("../app/store.ts");
  await update<any>(join(D, "library/people.json"), {}, (p) => { p.people["max3@x.test"].alias_of = "max@x.test"; });
  boards.invalidate();
  const p = await identity.personByEmail("max3@x.test");
  expect(p.id).toBe("max");
  expect(p.dir).toBe(join(D, "library"));
  expect((await identity.personById("max-3"))!.id).toBe("max");
  const r = (await boards.teamProject(await catalog(), "frequency"))!;
  expect(r.people.filter((x) => x.name === "Max").map((x) => x.id)).toEqual(["max"]); // Max once
  const max = r.people.find((x) => x.id === "max")!;
  expect(max.items.map((i: any) => i.id).sort()).toEqual(["max-3:projects/max3-chair", "max:projects/max-room"]);
  expect(boards.canEdit("max", "tnm")).toBe(true);
  // An alias pointing at itself, or round in a circle, stops instead of looping.
  await update<any>(join(D, "library/people.json"), {}, (p) => { p.people["lee@x.test"].alias_of = "eve"; p.people["eve@x.test"].alias_of = "lee"; });
  expect((await identity.personByEmail("lee@x.test")).id).toBeDefined();
});

// ── Sign-in at the door with a board invite (Google's token checked against a test key) ──
test("signing in with a board invite cookie joins that board, and only that one", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk: any = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test", alg: "RS256", use: "sig" };
  write("jwks.json", { keys: [jwk] }); Bun.env.RECALL_TEST_JWKS = join(D, "jwks.json");
  write("library/google.json", { clientId: "test-client" });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = async (email: string) => {
    const head = b64({ alg: "RS256", kid: "test" }), body = b64({ aud: "test-client", iss: "https://accounts.google.com", exp: Date.now() / 1000 + 600, email, email_verified: true, given_name: "T", picture: "https://lh3.googleusercontent.com/a/X=s96-c" });
    const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  const inv = (await boards.createInvite("client-work", "pat"))!;
  expect(boards.canSee("lee", "client-work")).toBe(false);
  const signIn = async (email: string, cookie: string) => google.googleSignIn(new Request("http://door/auth/google", { method: "POST", headers: { "x-recall": "1", cookie, "content-type": "application/json" }, body: JSON.stringify({ credential: await token(email) }) }));
  const r = await signIn("lee@x.test", `recall_board=${inv.token}`);
  expect(r.status).toBe(200);
  expect(boards.canSee("lee", "client-work")).toBe(true);
  expect(r.headers.getSetCookie().some((c) => c.startsWith("recall_board=;") && c.includes("Max-Age=0"))).toBe(true);
  expect((await identity.listPeople()).people["lee@x.test"].picture).toBeUndefined(); // pictures stay off until Max says so
  // The sign-in page treats a live board invite like the team link ("your own library is created...").
  const fresh = (await boards.createInvite("client-work", "pat"))!;
  expect(await (await google.signInPage(new Request("http://door/signin", { headers: { cookie: `recall_board=${fresh.token}` } }))).text()).toContain("created the first time");
  expect(await (await google.signInPage(new Request("http://door/signin", { headers: { cookie: `recall_board=${inv.token}` } }))).text()).not.toContain("created the first time"); // spent
  // An unknown Google account with no invite and no team link stays out.
  expect((await signIn("stranger@x.test", "")).status).toBe(403);
  // The friends link: an account of their own, not the team board. An old or wrong friends code doesn't count.
  expect((await signIn("pal@x.test", "recall_friend=wrongwrongwrongwrong")).status).toBe(403);
  const entry = await google.teamEntry(await google.friendCode(), "friend");
  const fc = entry.headers.get("set-cookie")!.split(";")[0];
  expect(fc.startsWith("recall_friend=")).toBe(true);
  expect((await google.teamEntry("wrongwrongwrongwrong", "friend")).status).toBe(404);
  expect((await signIn("pal@x.test", fc)).status).toBe(200);
  const pal = (await identity.listPeople()).people["pal@x.test"];
  expect(pal).toBeTruthy();
  expect(boards.canSee(pal.id, boards.defaultId())).toBe(false);
  expect((await signIn("pal@x.test", "")).status).toBe(200); // after that, any browser
});
