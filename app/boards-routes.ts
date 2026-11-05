// The team boards' web addresses. server.ts merges these into its routes: `...boardRoutes(withPerson)`.
// Every board read checks membership first; a board you're not on answers like one that doesn't exist.
// The old single-board addresses (/api/team…, /api/board, /board/zip, /board/img) still work, for the default board.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import * as boards from "./board.ts";
import * as topics from "./topics.ts";
import { projectsOf } from "./projects.ts";
import { loadCatalog } from "./librarian.ts";
import { listPeople, personById, resolveLogin, type Person } from "./identity.ts";
import { page, esc, sessionEmail, BOARD_COOKIE } from "./door.ts";
import { avatarType, teamCode, friendCode } from "./google.ts";
import * as mailer from "./mailer.ts";
import { PUBLIC_URL } from "./config.ts";

type Handler = (req: Request, p: Person) => Promise<Response>;
type WithPerson = (fn: Handler) => (req: Request) => Promise<Response>;
const json = (data: unknown, status = 400) => Response.json(data, { status });
const param = (req: Request, name: string) => String((req as any).params?.[name] ?? "");
const query = (req: Request, name: string) => new URL(req.url).searchParams.get(name) ?? "";
const body = async (req: Request) => await req.json().catch(() => ({})) as Record<string, unknown>;
const PUBLIC = PUBLIC_URL;
const WEEK_S = 7 * 24 * 3600;
const nope = () => json({ error: "No such board." }, 404); // also for boards you aren't on: their names stay private

/** Members, once each (an alias shows as its person), with names and pictures. */
async function membersOf(b: boards.Board) {
  const out = new Map<string, { id: string; name: string; avatar: string | null; role: string }>();
  for (const [id, m] of Object.entries(b.members)) {
    const who = await personById(id); const pid = who?.id ?? id;
    const prev = out.get(pid);
    if (!prev || m.role === "owner") out.set(pid, { id: pid, name: who?.name ?? id, avatar: boards.avatarUrl(pid), role: m.role });
  }
  return [...out.values()].sort((a, c) => (a.role === "owner" ? -1 : c.role === "owner" ? 1 : a.name.localeCompare(c.name)));
}
const summary = (b: boards.Board, p: Person) => ({
  id: b.id, name: b.name, owner: b.owner, default: b.id === boards.defaultId(),
  role: boards.canEdit(p.id, b.id) ? "owner" : "member",
  members: Object.keys(b.members).length, projects: Object.keys(b.projects).length,
  // What this person shares there: their own project (from) → the board's project.
  mine: Object.entries(b.projects).flatMap(([project, bp]) => Object.entries(bp.shares).filter(([id]) => id === p.id).map(([, s]) => ({ project, from: s.from, since: s.since }))),
});

const inviteMail = (b: boards.Board, from: Person, link: string, email?: string) => {
  const subject = `Join the ${b.name} board on Recall`;
  const text = `Here's your link to the ${b.name} board on Recall:\n\n${link}\n\nOpen it and sign in with Google, and you're on the board. The link works once, for 7 days.\n\n${from.name}`;
  return `mailto:${email ? encodeURIComponent(email) : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
};

/** A board invite opened on a browser that isn't signed in (the public door, before its session check):
 *  remember the invite on this browser, then the usual Google sign-in, which joins the board. Otherwise null. */
export async function boardDoor(req: Request): Promise<Response | null> {
  const m = new URL(req.url).pathname.match(/^\/b\/([A-Za-z0-9_-]{20,64})$/); if (!m) return null;
  if (await sessionEmail(req)) return null; // signed in: the inner route below joins
  if (!boards.inviteInfo(m[1])) return page("This link doesn't work", "It may have been used already or be more than a week old. Ask for a new one.", 404);
  // Nothing is spent here, so a link preview in Messages or Mail can't use up the invite.
  return new Response(null, { status: 302, headers: { location: "/signin", "set-cookie": `${BOARD_COOKIE}=${m[1]}; Path=/; Max-Age=${WEEK_S}; HttpOnly; Secure; SameSite=Lax` } });
}

export function boardRoutes(withPerson: WithPerson) {
  const member = (fn: (req: Request, p: Person, b: boards.Board) => Promise<Response>) => withPerson(async (req, p) => {
    const b = boards.getBoard(param(req, "id")); return b && boards.canSee(p.id, b.id) ? fn(req, p, b) : nope();
  });
  const owner = (fn: (req: Request, p: Person, b: boards.Board) => Promise<Response>) => member(async (req, p, b) =>
    boards.canEdit(p.id, b.id) ? fn(req, p, b) : json({ error: "Only the board's owner can do that." }, 403));
  const knownProject = async (id: string) => projectsOf(await loadCatalog()).some((x) => x.id === id);
  const onDefault = (p: Person) => boards.canSee(p.id, boards.defaultId());

  return {
    // ── The default board, at the addresses today's UI uses (members only now) ──
    "/api/team": withPerson(async (_req, p) => json({ board: boards.defaultId(), member: onDefault(p), projects: onDefault(p) ? await boards.teamPanels(await loadCatalog()) : [] }, 200)),
    "/api/team/project": withPerson(async (req, p) => {
      const r = onDefault(p) ? await boards.teamProject(await loadCatalog(), query(req, "id")) : null;
      return r ? json(r, 200) : json({ error: "not shared" }, 404);
    }),
    "/api/team/share": { POST: withPerson(async (req, p) => {
      const b = await body(req); const id = String(b.project ?? "");
      if (!(await knownProject(id))) return json({ error: "no such project" });
      if (!onDefault(p)) return json({ error: "You're not on the dream board." }, 403);
      await boards.setShared(id, p.id, !!b.on); console.log(`[team] ${p.id} ${b.on ? "shared" : "stopped sharing"} ${id}`);
      return json({ ok: true, shared: !!b.on }, 200);
    }) },
    "/api/team/topic/rename": { POST: withPerson(async (req, p) => {
      if (!onDefault(p)) return json({ error: "not shared" }, 404);
      const b = await body(req); return json({ ok: await topics.rename(boards.TEAM_DIR, String(b.project), String(b.topic), String(b.name ?? "")) }, 200);
    }) },
    // The full-screen board page and its zip (?board= picks another board; default otherwise).
    "/api/board": withPerson(async (req, p) => {
      const id = query(req, "board") || boards.defaultId();
      if (!boards.canSee(p.id, id)) return json({ board: id, projects: [], project: null, cards: [], people: [] }, 200);
      return json(await boards.board(await loadCatalog(), query(req, "project"), id), 200);
    }),
    "/board/zip": withPerson(async (req, p) => {
      const id = query(req, "board") || boards.defaultId();
      return boards.canSee(p.id, id) ? boards.boardZip(await loadCatalog(), query(req, "project"), id) : new Response("not found", { status: 404 });
    }),
    // A picture on any board this person is on.
    "/board/img/*": withPerson(async (req, p) => {
      const u = new URL(req.url);
      return boards.boardImage(await loadCatalog(), p.id, decodeURIComponent(u.pathname.slice("/board/img/".length)), (["full", "small"].includes(u.searchParams.get("size") ?? "") ? u.searchParams.get("size") : "thumb") as boards.Size);
    }),

    // ── Boards ──
    "/api/boards": {
      GET: withPerson(async (_req, p) => json({ boards: boards.boardsFor(p.id).map((b) => summary(b, p)) }, 200)),
      POST: withPerson(async (req, p) => {
        const name = String((await body(req)).name ?? "").trim(); if (!name) return json({ error: "A board needs a name." });
        const b = await boards.createBoard(name, p.id); console.log(`[boards] ${p.id} made ${b.id}`);
        return json({ ok: true, board: summary(b, p) }, 200);
      }),
    },
    "/api/boards/:id": member(async (_req, p, b) => {
      const catalog = await loadCatalog();
      return json({ board: { ...summary(b, p), members: await membersOf(b) }, projects: await boards.teamPanels(catalog, b.id), pins: await boards.boardPins(catalog, b.id) }, 200);
    }),
    "/api/boards/:id/project": member(async (req, _p, b) => {
      const r = await boards.teamProject(await loadCatalog(), query(req, "id"), b.id);
      return r ? json(r, 200) : json({ error: "not shared" }, 404);
    }),
    // Share one of your own projects (from) into a board project (project); on:false stops.
    "/api/boards/:id/share": { POST: member(async (req, p, b) => {
      const x = await body(req); const project = String(x.project ?? ""); const from = String(x.from ?? project);
      if (!(await knownProject(project)) || !(await knownProject(from))) return json({ error: "no such project" });
      await boards.setShared(project, p.id, x.on !== false, b.id, from);
      console.log(`[boards] ${p.id} ${x.on !== false ? "shared" : "stopped sharing"} ${from} → ${b.id}/${project}`);
      return json({ ok: true, shared: x.on !== false }, 200);
    }) },
    // Add someone who already uses Recall ({email} or {person}), or take someone off ({…, remove: true}).
    // The owner does both; anyone may take themselves off.
    "/api/boards/:id/members": { POST: member(async (req, p, b) => {
      const x = await body(req); let id = String(x.person ?? "");
      if (!id && x.email) { const people = await listPeople(); id = resolveLogin(people, String(x.email))?.rec.id ?? ""; }
      const who = id ? await personById(id) : null;
      if (!who) return json({ error: "They haven't opened Recall yet. Send them an invite link instead." }, 404);
      if (!(boards.canEdit(p.id, b.id) || (x.remove && who.id === p.id))) return json({ error: "Only the board's owner can do that." }, 403);
      const ok = x.remove ? await boards.removeMember(b.id, who.id) : await boards.addMember(b.id, who.id, p.id);
      if (!ok) return json({ error: x.remove ? "The owner can't be taken off their own board." : "Couldn't add them." }, 409);
      console.log(`[boards] ${p.id} ${x.remove ? "removed" : "added"} ${who.id} ${x.remove ? "from" : "to"} ${b.id}`);
      return json({ ok: true, members: await membersOf(boards.getBoard(b.id)!) }, 200);
    }) },
    // A one-use link (7 days) plus an email draft for the person to send themselves: Recall never sends email.
    "/api/boards/:id/invite": { POST: owner(async (req, p, b) => {
      const email = String((await body(req)).email ?? "").trim() || undefined;
      if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return json({ error: "That email doesn't look right." });
      const inv = await boards.createInvite(b.id, p.id, email); if (!inv) return nope();
      const link = `${PUBLIC}/b/${inv.token}`;
      console.log(`[boards] ${p.id} made an invite to ${b.id}`);
      return json({ ok: true, link, expires: inv.expires, mailto: inviteMail(b, p, link, email) }, 200);
    }) },
    // The Invite button: the team link, for anyone on the Dream board to pass on in the team's own chat. Whoever
    // opens it and signs in with Google gets their own library and joins the Dream board (google.ts).
    "/api/boards/:id/link": member(async (_req, p, b) => b.id === boards.defaultId()
      // The owner also gets the friends link: their own Recall, not the Dream board.
      ? json({ ok: true, link: `${PUBLIC}/team/${await teamCode()}`, ...(boards.canEdit(p.id, b.id) ? { friends: `${PUBLIC}/invite/${await friendCode()}` } : {}) }, 200)
      : json({ error: "Only the Dream board has a team link." }, 404)),
    // Kept for later, not on screen: invites sent to typed emails (through Resend) or phone numbers.
    // The Invite box: emails and phone numbers, typed or pasted together. Each one gets its own one-use link.
    // An email is sent by Recall when sending is set up (mailer.ts), otherwise it comes back as a ready email;
    // a phone number comes back as a ready text, for the inviter's own Messages. On the default (Dream) board
    // any member may invite, as anyone there can already pass on the team link; on other boards, the owner.
    "/api/boards/:id/invites": { POST: member(async (req, p, b) => {
      if (!(boards.canEdit(p.id, b.id) || b.id === boards.defaultId())) return json({ error: "Only the board's owner can invite people." }, 403);
      const parts = String((await body(req)).to ?? "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (!parts.length) return json({ error: "Type an email or a phone number." });
      const replyTo = /@invite\.recall$/.test(p.email) ? undefined : p.email;
      const where = b.id === boards.defaultId() ? "the Dream board" : `the ${b.name} board`;
      const results = [];
      for (const to of parts) {
        const email = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to) ? to.toLowerCase() : "";
        const phone = !email && /^\+?[\d\s().-]{7,}$/.test(to) && to.replace(/\D/g, "").length >= 7 ? to.replace(/[^\d+]/g, "") : "";
        if (!email && !phone) { results.push({ to, status: "bad" }); continue; }
        const inv = await boards.createInvite(b.id, p.id, email || undefined); if (!inv) return nope();
        const link = `${PUBLIC}/b/${inv.token}`;
        const text = `${p.name} invited you to ${where} on Recall.\n\nOpen this link and sign in with Google:\n${link}\n\nThe link works once, for 7 days.`;
        if (phone) { results.push({ to, status: "text", phone, text }); continue; }
        if (mailer.ready()) {
          try { await mailer.send(email, `${p.name} invited you to ${where} on Recall`, text, replyTo); results.push({ to, status: "sent" }); continue; }
          catch (e) { console.error(`[boards] invite email not sent: ${String(e).slice(0, 200)}`); }
        }
        results.push({ to, status: "draft", mailto: inviteMail(b, p, link, email) });
      }
      console.log(`[boards] ${p.id} invited ${results.filter((r) => r.status !== "bad").length} to ${b.id}`);
      return json({ ok: true, results }, 200);
    }) },
    "/api/boards/:id/hide": { POST: owner(async (req, _p, b) => { const x = await body(req); return json({ ok: await boards.setHidden(b.id, String(x.item ?? ""), x.on !== false) }, 200); }) },
    "/api/boards/:id/pin": { POST: member(async (req, p, b) => {
      const x = await body(req); const item = String(x.item ?? "");
      // Only something already on this board can be pinned to it.
      if (x.on !== false && !(await boards.onBoard(await loadCatalog(), b.id, item))) return json({ error: "That isn't on this board." }, 404);
      return json({ ok: await boards.setPinned(b.id, item, p.id, x.on !== false) }, 200);
    }) },
    "/api/boards/:id/topic/rename": { POST: member(async (req, _p, b) => {
      const x = await body(req); return json({ ok: await topics.rename(boards.boardDir(b.id), String(x.project), String(x.topic), String(x.name ?? "")) }, 200);
    }) },

    // ── An invite, opened by someone signed in: one button joins (a GET alone never spends it) ──
    "/b/:token": {
      GET: withPerson(async (req, p) => {
        const token = param(req, "token"); const hit = boards.inviteInfo(token);
        const already = boards.boardsFor(p.id).find((b) => b.id === hit?.board.id);
        if (already) return new Response(null, { status: 302, headers: { location: `/?board=${encodeURIComponent(already.id)}` } });
        if (!hit) return page("This link doesn't work", "It may have been used already or be more than a week old. Ask for a new one.", 404);
        return page(`Join ${esc(hit.board.name)}`, `You're signed in as ${esc(p.name)}. Join the board to see everyone's projects on it.
<button id="join" style="margin-top:18px;font:inherit;font-weight:600;padding:14px 22px;border:0;border-radius:12px;background:#2d5a46;color:#fff;width:100%;cursor:pointer">Join the board</button>
<p id="err" style="color:#9b2d2d;min-height:1.2em"></p>
<script>document.getElementById('join').onclick=async(e)=>{e.target.disabled=true;const r=await fetch(location.pathname,{method:'POST',headers:{'x-recall':'1'}});const d=await r.json().catch(()=>({}));if(r.ok)location.href=d.next||'/';else{e.target.disabled=false;document.getElementById('err').textContent=d.error||'That didn\\'t work. Try again.';}};</script>`);
      }),
      POST: withPerson(async (req, p) => {
        if (req.headers.get("x-recall") !== "1") return json({ error: "Join from the Recall page." }, 403); // a cross-site form can't set this
        const r = await boards.acceptInvite(param(req, "token"), p.id);
        if (!r) return json({ error: "This link has been used already or is more than a week old. Ask for a new one." }, 410);
        if (r.joined) console.log(`[boards] ${p.id} joined ${r.board} with an invite`);
        return json({ ok: true, board: r.board, next: `/?board=${encodeURIComponent(r.board)}` }, 200);
      }),
    },

    // A teammate's round picture: only for someone who shares a board with them. No picture → 404 (the UI shows initials).
    "/avatar/:id": withPerson(async (req, p) => {
      const id = param(req, "id"); const file = join(boards.AVATARS, `${id}.jpg`);
      if (!/^[a-z0-9-]+$/.test(id) || !boards.sharesBoard(p.id, id) || !existsSync(file)) return new Response("not found", { status: 404 });
      const bytes = readFileSync(file);
      return new Response(bytes, { headers: { "content-type": avatarType(bytes) ?? "image/jpeg", "cache-control": "private, max-age=3600" } });
    }),
  };
}
