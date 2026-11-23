# Good morning: Recall, 23 Nov

Everything below is built, tested on the twin and saved in git. **None of it is on the live site.** You approve, then I deploy.

Open the twin: http://localhost:4344 (if it doesn't open, run `bin/cl twin start` in this folder).

## Do first

1. **Open the twin on your Mac and try the five things under "What to try".**
2. **Say "live"** (or tell me what to change first).
3. **Answer the decisions below.** A numbered voice note is fine.

## What was built

1. **Agents** (new tab). Type what you want moved forward, or tap "Hand to an agent" on a reminder or a saved item. The agent researches on the web, checks if it can be done, finds people to talk to, drafts messages and lists next steps. It stops at the first judgment point and asks one question with options. Your answer starts the next round. It never sends anything.
2. **Agents start on their own** on new ideas from your notes and meetings: at most 3 a day, only for you, with a switch on the Agents tab.
3. **Three tabs in every project:** Share, Create, Remind. One at a time; each starts by picking artifacts.
   - **Create** makes a board video, a reel (upright, sound levelled) or post pictures from what you pick, in a queue. "Made" shows what is ready.
   - **Remind** puts what you picked into Remind with your note on how, when and what for. Say a day and it first comes back then.
4. **Sparks.** Your older notes are read slowly (24 pages a day at most) for lines worth bringing back. A switch is at the bottom of the Remind tab.
5. **Today** (new tab), from the everything dashboard: your way of being for the day, your three current projects, and what is waiting on you.
6. **Connectors page** (`/connectors`): Granola, Otter, Apple Notes, Google Drive, Metricool, Canva, each with its status.

## What to try (about 5 minutes)

1. **Agents tab:** two runs are waiting with a question. Tap an option and watch it carry on.
2. **Agents tab:** type something real you want moved forward.
3. **Find, open Zero Proof Lounge, tap Create, then Made:** play the board video and the reel.
4. **Same project, tap Remind:** pick a picture, write a note, add it.
5. **Today tab:** tap a "Your call" row.

## Decisions only you can make (my recommendation first)

1. **Seven tabs on a phone.** They scroll sideways now. Recommend: a bar at the bottom with Today, Save, Find, Remind, Agents; Clarify becomes a row on Today, Improve a link.
2. **Agent model.** It runs on Claude Haiku 5.5 with web search (your call, 23 Nov). A stronger model is one setting (`AGENT_CLAUDE_MODEL`).
3. **Agents on local models.** The server has 4 GB of memory and no chat model; it cannot run one. Options: a bigger server (about $48 a month for 16 GB), or your Mac's model when it is awake. Recommend: stay on Claude until the agents prove useful.
4. **Agents for the team.** Self-starting is on for you only. Teammates can hand things over by hand. Recommend: leave it.
5. **What an agent may do after your answer.** Tonight it only writes. Next: a calendar block, or sending a message after your yes. Tell me which first.
6. **Reels.** Tonight a reel is reshaped and levelled, nothing more. Silence cuts, subtitles and overlays (your edit-video way) are next. Recommend: yes, as the next Create step.
7. **The connect card** (Granola, Otter) shows on every tab. Recommend: Save tab only.

## What needs you (keys and sign-ins)

Each is one paste on the Keys page, linked from `/connectors`.

1. **Metricool** (drafts to Instagram and LinkedIn): API token, user id, brand id. Code is written, never run against Metricool.
2. **Canva:** create an integration in Canva's developer portal, paste client id and secret. Never run against Canva.
3. **Google Drive:** a client secret, and one redirect address added in Google's console. Never run against Google.
4. **Apple Notes:** run one script on the Mac and approve the macOS prompt. Never run against your Notes.

## Not verified

- **Notifications from agents on a real phone.** The twin has no phone signed up. The same push code as Remind is used.
- **The four connectors above**, for the reasons given.
- **Sparks on your real library.** Tested on test notes only. It may quote a line from a transcript that isn't yours; tell me if it does.
- **12 older tests fail** (Creator mode budget, team board first load, the Chrome manifest). They failed before tonight too (21 then). My 20 new tests pass.

## Wording to check (functional labels, shipped on the twin)

- Tabs: "Today", "Agents"
- Agents: "What do you want moved forward?" · "Hand to an agent" · "Start an agent on new ideas from my notes and meetings" · "Needs your call" · "Or say it your way" · "Finish here" · "A draft. Nothing is sent." · step names "Research", "Can it be done", "People to talk to", "Draft message", "Next steps"
- Notification: "Your call: ‹title›" and "Done: ‹title›"
- Project: "Share" · "Create" · "Remind" · "Make" · "Made" · "How and why?" · "How, when and what for?" · "Add to queue" · "Add to Remind"
- Create formats: "Board video" · "Reel" · "Post pictures"
- Today: "Way of being" · "Current work" · "Waiting on you" · "Your call: ‹title›"
- Remind tab: "Sparks: read your older notes for lines worth bringing back. N of M read."
- Connectors: "Comes in" · "Goes out" · "On" · "Ready to connect" · "Needs you" · "Uses the shortcut"

## Reviews run overnight

- **Engineer:** no blockers. Seven fixes applied (reel sound, agent deadlines, lighter polling, cost caps).
- **Designer:** fifteen items. Applied: radii, spacing, type, gold only on the one main button, picked tiles.
- **UX:** sixteen items. Applied: cards keep their place, "You said", Today rows open the right run, Create offers only what the picks can make. Left for you: the tab bar and the connect card (decisions 1 and 7), Undo on Remove.

## Roll back

Tag `before-overnight-2` is the state before tonight. Nothing live changed.
