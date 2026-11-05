# Recall goes live (spec, started 4 Nov 2026)

The contract for the go-live chat. New asks go into this file, in order, not into the chat.

## Goal

Max sends Recall to everyone he knows. Each person opens it on a phone or a computer, understands it, sets it up alone, uses it every day, and their notes, meetings, docs and pictures flow in by themselves.

## Done test

A friend who has never heard of Recall gets one iMessage from Max. With Max unreachable and his laptop closed, on their own phone, they:
1. understand what Recall is within 30 seconds of tapping the link,
2. sign in and finish setup,
3. save three things and find one again by describing it,
4. invite one friend,
5. and the next day, their new Apple Notes and meetings are in their Recall without them doing anything.

## The monkey

**Recall running without Max's Mac.** Today the MacBook is the server: when it sleeps, travels or goes offline, Recall is down for everyone, and nothing can sync overnight.

Hidden hinges, to settle before building on them:
- **The sorting AI on a server.** A server has no graphics chip, so the local model is slow (estimate: about a minute a save). A cloud model sorts in seconds, but what people save is then sent to that company, and the privacy page must say so.
- **Google's review.** Reading a person's whole Google Drive is a "restricted" permission. Up to 100 people can use it behind Google's "unverified app" warning. Past 100, Google requires a paid security review that takes weeks.
- **Apple has no API** for Photos, Notes or Voice Memos. Those connectors run as automations on each person's own iPhone or Mac.

## What gets sent, and how

- **One iMessage from Max**, in his own words, with one link. (iMessage, because Google blocks sign-in inside the Gmail and WhatsApp apps.)
- **The link opens a welcome page** in the browser, phone or computer, no app store: what Recall is, why it exists, what it's for, a 60-second video of Max, and one Start button.
- **Start** → Google sign-in → the setup steps that exist today (shortcut, real pictures) → the first save.
- **The manual** lives inside Recall: click-by-click, one picture per step, phone and computer. Set up, save, find, projects, boards, invite, connect your sources, a day with Recall.

## Workstreams, in order

0. **The team, today, on the Mac.** Max texts the team link to the team. The Mac stays plugged in and awake. Nothing else waits on this.
1. **The server (the monkey).** Rent it, move Recall and every library onto it, point the web address at it, keep the Mac as a client. Nightly backups.
2. **Welcome page, manual, video.** Wireframe first, then Max's words.
3. **Long documents split into pieces.** A long doc or meeting stays whole as one item; its pieces (ideas, actions, decisions, reflections) are pulled out, each sorted into its own project, each linking back to the exact spot.
   - **Built 4 Nov, on the twin, waiting for Max's "live".** `app/pieces.ts`. Any save over 8,000 characters (except pictures and video) is filed whole as before, then read a part at a time (about 6,000 characters, about 30 seconds a part on the Mac) only while no new save is waiting. Each idea, action, decision, realization or reflection becomes a small item in the project it names, else the whole item's project. Its words must be in the text word for word, or it is dropped. Small talk and repeats are dropped. The item page shows "From ‹whole item›", which opens the whole at that passage, highlighted; the whole lists its pieces. Pieces read up to 1M characters; the whole item's page still keeps the first 200k.
   - Twin test: a 16k-character team meeting gave 8 pieces, 8 of its 9 real points, each in the right lounge (the whole was filed under Zero Proof only). Searching "room where the floor shakes with sound" finds the vibrating-floor piece. Unit tests: `tests/pieces.test.ts`.
   - Later: run it over the 393 Google Docs already in the library (about 30 seconds a part, so overnight).
4. **Connectors**, one at a time, each tested on the twin:
   - a. Voice notes: Voice Note shortcut (built), Recall Camera (built, twin).
   - b. Pictures: an iPhone automation sends new photos from a "Recall" album every night.
   - c. Apple Notes: an iPhone or Mac automation sends notes changed that day, every night.
   - d. Meeting recorders: Connect buttons for Otter, Granola and Wispr Flow per person (built for the Soul Map; moves into Recall). Memoket needs access.
   - e. Google: Docs and Drive files the person owns, synced nightly.
   - f. Claude: Recall as a connector inside Claude ("save this to Recall"; Claude searches your Recall), plus a one-time import of a Claude history export.
5. **Sharing.**
   - Invite: the team link and the Invite button (built).
   - Send a project to a friend: a link that opens that board read-only, with a Start your own Recall button.
   - Video: Make a video on any board turns its pictures and words into a short vertical video ending on the Recall link, to text or post.

## Needed from outside (ask once, up front)

- Max: the server account and payment (Hetzner, about €10.49 a month for the CAX21, checked 27 Oct).
- Max: the sorting AI choice (local on the server, or a cloud model) and the privacy line that goes with it.
- Max: a 60-second video, his face, his words. Claude edits it.
- Max: the iMessage text, in his words, and who gets it.
- Each person: their own Otter / Granola sign-in when they press Connect.
- Memoket access (step 4d).

## Rules

Twin first, then production with Max's yes. New on-screen words get Max's exact OK. Recall drafts; Max sends. Private library contents never go into git.
