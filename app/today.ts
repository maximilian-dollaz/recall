// Today: the first three pieces of the "everything dashboard" (Max, 22 Nov 2026), built only from what Recall
// already holds. One screen for the start of a day:
//   Way of being     one of the person's own lines about how they want to be, chosen for the day (the same one all
//                    day, a different one tomorrow), with its "When ..., I ..." line.
//   Current work     the three projects most recently added to, each one tap away.
//   Waiting on you   what only the person can move: agents at a judgment point, Clarify questions, reminders
//                    still landing, and saves brought back today.
// The calendar and "life orientation" parts of the dashboard are not here yet: they need a calendar connection.

import * as remind from "./remind.ts";
import * as agents from "./agents.ts";
import * as cues from "./cues.ts";
import * as projects from "./projects.ts";
import { due as dueReminders } from "./reminders.ts";
import type { Catalog } from "./librarian.ts";
import type { Person } from "./identity.ts";

export async function today(p: Person, catalog: Catalog, now = new Date()) {
  const day = remind.localDay(now);
  const sparks = remind.ledger(p.dir).sparks;
  const live = sparks.filter((s) => s.state === "on" || s.state === "being");
  // A way of being first; without one, a principle; without one, nothing (never a filler line).
  const pool = [live.filter((s) => s.kind === "being"), live.filter((s) => s.kind === "principle")].find((l) => l.length) ?? [];
  const pick = pool.length ? [...pool].sort((a, b) => a.id.localeCompare(b.id))[Number(Bun.hash(day) % BigInt(pool.length))] : null;
  const held = live.filter((s) => s.hold && new Date(s.hold) > now).length;
  const dueToday = live.filter((s) => new Date(s.next) <= new Date(now.getTime() + 864e5) && !(s.hold && new Date(s.hold) > now)).length;
  const runs = agents.list(p.dir).runs;
  return {
    day,
    being: pick ? { id: pick.id, title: pick.title, words: pick.words, when_then: pick.when_then ?? null, date: pick.from.date } : null,
    work: projects.projectsFor(p.dir, catalog).slice(0, 3).map((r) => ({ id: r.id, name: r.name, count: r.count, thumbs: r.thumbs.slice(0, 4), latest: r.latest })),
    waiting: {
      agents: runs.filter((r) => r.status === "needs-you").slice(0, 3).map((r) => ({ id: r.id, title: r.title, question: r.ask?.question ?? "" })),
      agentsWorking: runs.filter((r) => r.status === "working" || r.status === "queued").length,
      clarify: (await cues.list(p.dir)).length,
      landing: held,
      reminders: dueToday,
      back: (await dueReminders(p.dir)).slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
    },
  };
}
