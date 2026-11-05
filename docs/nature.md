# Recall's design follows nature

> what natural systems (as in ecosystems or systems within nature) can we copy so that we are basing the architecture on another system that is in alignment with truth?
> — Max, 28 Oct 2026

Nature doesn't use one system for this. It layers several, and each one does one job. Recall copies each of them for the same job it does in nature. The tree gives Recall its shape ([categories.md](categories.md)). This page covers the rest: how things flow in, where they're held, how they're sorted, kept and brought back.

What they share: **no central planner.** Nobody designs the categories. Structure comes from flow and use, and nothing is destroyed for being old.

Status: **Built** works today. **Partly** means some of it works. **Next** is on the [roadmap](../ROADMAP.md).

---

## Streams and tributaries: how things come in · Built, more coming

**In nature:** water doesn't wait to be carried. It runs downhill from wherever it falls, in many small streams that join into one river.

**In Recall:** every place life is already recorded is a stream that runs into one intake (`/api/save`). Today's streams: the iPhone share sheet, the Mac shortcut (⌃⌥S), Finder, the Save page, Chrome's right-click, and the terminal. Nobody carries anything to a folder; you save where you are. The next tributaries join on their own, with no one saving by hand: Apple Notes, a "Recall" photo album, meeting recorders, Google Docs, Claude.

## The holding pond: nothing is lost on the way in · Built

**In nature:** a pond above a river takes in a sudden storm and lets it out at the rate the river can carry.

**In Recall:** a save is kept the instant it arrives: the original file goes to your folder, and the job waits in your `inbox/`. The librarian lets it out one at a time. If the local model or the library is down, the water waits and is retried every hour. It never spills. A job that fails three times is set aside, still visible, never deleted.

## The watershed: one save, one project · Built

**In nature:** a raindrop is never assigned to a river. Gravity takes it to exactly one basin, and the basins are carved by the water itself.

**In Recall:** the sentence you say when you save ("this is for Zero Proof") is gravity. Every save lands in exactly one project. A project exists the first time something flows to it; nobody designs it in advance. When the slope is unclear (you named two projects, or none), the drop pools in **Clarify** until you answer one question. What you say always wins over the model's guess (`app/projects.ts`).

## The reservoir: one body of water per person · Built

**In nature:** a reservoir holds water so a whole valley can draw on it when it needs to, and releases it on a schedule too.

**In Recall:** each person's library is their reservoir: every save is one page in their own store (GBrain), searchable by meaning. It releases water two ways. **On demand:** describe what you need and it comes back (Find). **On a schedule:** "bring this back next Friday" opens the gate on that day ("Brought back for you"). Things marked **Keep local** go to a sealed cistern (`app/vault.ts`) that only the local model can read.

## The delta: long documents spread into many channels · Built

**In nature:** where a river meets the sea, it splits into many small channels, and each one lays its sediment down where it belongs.

**In Recall:** a long document, meeting or voice note is read a part at a time, and each idea, action, decision, realization and reflection becomes its own small item, laid down in the project it's about. The whole river keeps flowing too: the original stays whole, and every piece links back to its exact spot (`app/pieces.ts`).

## Cells: topics that form, divide and fuse · Built

**In nature:** cells gather, grow, divide when they get too big, and merge when they're the same.

**In Recall:** inside each project, topics form on their own. Three close items become a topic. A topic over 13 divides in two. Two topics that keep catching the same items fuse. A topic that shrinks below 3 joins its nearest neighbor. Loose items wait like stem cells until they fit somewhere. A topic you renamed keeps its name, and an item you moved stays where you put it (`app/topics.ts`).

## The seed bank: ideas wait for the right moment · Partly

**In nature:** seeds carry their own condition for sprouting (a temperature, light, after a fire) and can stay alive for decades.

**In Recall:** every save is a seed, not a task. It keeps a state (idea, doing, done, parked) and can carry its own condition: a date ("next Friday") or a moment ("when we work on the lobby"). Nothing is deleted for being old; dormant is a state, not a failure. Deleted items go to a trash with Undo. **Next:** the moment as a trigger: when you start work on something, Recall brings up the five ideas you already had for it.

## The fungal network: separate trees, shared nutrients · Partly

**In nature:** trees in a forest stay separate, but fungus between their roots carries nutrients from one to another.

**In Recall:** each person keeps their own library. A Dream board is the network: a shared project is read live from each person's own library, never copied, with their name and face on what they brought (`app/board.ts`). **Next:** threads between items (the same person, place or idea in two people's libraries).

## Ant trails: what's used grows stronger · Next

**In nature:** ants don't vote on the best path. A trail grows stronger each time it's walked and fades when it isn't.

**In Recall:** every time an item is found, opened or sent, its trail will grow stronger, so what people actually use rises and what nobody touches sinks, without ever being removed.

## Sleep: the library tidies itself at night · Next

**In nature:** the brain doesn't file memories as they happen. At night it replays the day, links new memories to old ones, and keeps what connected.

**In Recall:** a nightly pass will reread the day's saves, link each to older ones, and settle the topics. New groups are proposed after the replay, when several seeds have landed close together, not at the moment of saving.

## Memory: recall like the mind recalls · Built, more coming

**In nature:** the mind doesn't keep a folder path. It keeps loose cues (a place, a picture, a feeling, a person) and one memory lights up its neighbors. Bringing something back strengthens it, most of all at growing intervals.

**In Recall:** every cue is a way in. Describe it loosely, open the project, filter by kind, by person, by time. Pictures come first, because they're recognized fastest. **Next:** your best ideas brought back on a widening rhythm, so they become part of who you are.

---

| Nature | Its job in Recall | Status |
| --- | --- | --- |
| Tree | Shape: projects, topics, items | Built |
| Streams and tributaries | Saving from everywhere into one intake | Built, more coming |
| Holding pond | Nothing lost on the way in | Built |
| Watershed | One save, one project | Built |
| Reservoir | One library per person, released on demand or on a date | Built |
| Delta | Long documents split into pieces | Built |
| Cells | Topics that form, divide and fuse | Built |
| Seed bank | Ideas wait for their moment | Partly |
| Fungal network | Sharing between people | Partly |
| Ant trails | What's used rises | Next |
| Sleep | Nightly consolidation | Next |
| Memory | Recall by any cue | Built, more coming |
