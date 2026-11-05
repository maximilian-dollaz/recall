# How Recall works

One Mac runs everything: the app, the library, and the models. Phones and other computers are windows onto it.

```
 Roots (where life is recorded)            Trunk (one intake, one librarian, one search)          Branches and leaves
 ─────────────────────────────            ────────────────────────────────────────────          ───────────────────
 iPhone shortcut (share + talk) ─┐
 Mac ⌃⌥S / Finder Quick Action ──┤        app/server.ts  /api/save                              library/   (the owner)
 Save page (drop, paste, talk) ──┼──────▶   keep the original  →  inbox job                 ┌─▶ libraries/<person>/
 Chrome extension (right-click) ─┤          → extract.ts   (text, OCR, frames, transcript)  │     projects → topics → items
 cl add / cl save (terminal) ────┘          → librarian.ts (local model: title, tags,       │     one markdown page per item
                                              project, private?, action?)                  │
                                            → projects.ts  (what you said wins)            │   Find: describe it
                                            → GBrain put_page  ─────────────────────────────┘   Boards: share projects
                                            → cues.ts (Clarify), reminders.ts, dupes.ts         Creator mode: make from them
                                            → pieces.ts (long items, a part at a time)
```

## The parts

| Part | Files | What it does |
| --- | --- | --- |
| Web app | `app/server.ts` | One Bun server on three ports: the gate (3344, the app), inner (3345), and the public door (3346, behind a tunnel). Identity, routes, saving, filing, Find. |
| Settings | `app/config.ts`, `.env` | This install's address, owner and contact. `.env` is never committed. |
| Identity | `app/identity.ts`, `app/google.ts`, `app/door.ts`, `app/keys.ts` | Who is asking: Google sign-in (cookie), Tailscale login on the private network, invite links, and a personal save key for phone shortcuts. Each person gets their own library on first sign-in. |
| Extraction | `app/extract.ts`, `tools/ocr.swift` | Text from documents (pdftotext, mammoth), pictures (described by the local vision model, text read by Apple's OCR), video (frames described), voice (ffmpeg + mlx-whisper), links (readability). |
| Librarian | `app/librarian.ts` | A small local model (Gemma 3 4B through Ollama) files each item: shelf, title, tags, one-line summary, project, sensitive, action. It never edits an item. |
| Projects | `app/projects.ts` | Projects come from what the person said. A named project always wins over the model's guess; when nothing is named, Clarify asks. |
| Topics | `app/topics.ts` | Groups inside a project that form, divide and fuse like cells, using local embeddings. The person always wins: a renamed topic keeps its name, a moved item stays. |
| Pieces | `app/pieces.ts` | A long doc, meeting or voice note is read a part at a time; each idea, action, decision, realization and reflection becomes its own item, linked back to its spot. |
| Clarify | `app/cues.ts` | One question per item the system can't answer alone: which project, private or shareable, when should it come back. |
| Reminders | `app/reminders.ts` | "Bring this back next Friday", read by code, not guessed. |
| Library | GBrain (`app/gbrain.ts`) | Every item is a markdown page with frontmatter, in the person's own GBrain source. One `gbrain serve --http` on 127.0.0.1:3131 owns the database (PGLite); each person's app client can reach only their source. Search is hybrid: keywords plus local embeddings (nomic-embed-text). |
| Keep local | `app/vault.ts` | Items marked private go to a SQLite full-text store instead, and are never given to any model beyond the local one. |
| Boards | `app/board.ts`, `app/boards-routes.ts` | Dream boards: projects people chose to share, read live from their own libraries, never copied. Members, invites, faces. |
| Creator mode | `app/visualize.ts`, `app/static/ui/visualize.js` | Everyone drags pictures and words from a board into one panel; the local model writes one prompt; Higgsfield or OpenAI makes the image or video; Keep files it into a project. |
| Voice | browser speech, `app/deepgram.ts`, mlx-whisper | Live words while you talk; recorded notes are transcribed on the Mac unless a Deepgram key is added. |
| Safety | `app/store.ts`, `app/trash.ts`, `app/dupes.ts` | Settings files written so two saves at once can't wipe them; deletes kept 30 days with Undo; duplicates spotted and asked about once. |
| Capture | `shortcuts/`, `extension/` | The iPhone and Mac shortcuts are built per person and served at `/my-shortcut`. Recall for Chrome is a Manifest V3 extension. |
| Soul Map door | `app/soul.ts` | Optional. Passes `/soul` to the Soul Map, a separate app on 127.0.0.1:3355, with the signed-in person's identity. |
| Command line | `bin/cl` | Save, add, ask, invite, team link, the twin, the services. |
| Services | `server/*.plist`, `install.sh` | launchd services for the app, the library server and the tunnel, rendered for each Mac by the installer. |

## A save, step by step

1. A save arrives at `/api/save` with files, a link, and the person's sentence (typed or spoken).
2. The originals are written to the person's `files/` folder at once, and a job lands in their `inbox/`. The person sees "✓" right away.
3. A background loop takes one job at a time: extract the text, ask the librarian, decide the project, write the page to GBrain, add tags.
4. Anything the system can't decide becomes one Clarify card. A spoken date becomes a reminder. A copy of something already saved is flagged.
5. A long item is queued for pieces, which run only while no new save is waiting.
6. If a service is down, the job waits and is retried; a job that fails three times is set aside, never lost.

## Where data lives

- `library/` is the owner's library and `libraries/<person>/` everyone else's: pages, files, inbox, reminders. Never committed.
- `~/.gbrain/` holds the database, the server's credentials and logs. Never committed.
- `.env` holds this install's settings. Keys pasted on the Keys page are stored under `~/.gbrain/serve/` and never shown again.

## What leaves the Mac

Nothing, unless it is switched on: Google sign-in; Chrome's speech service in the extension; Deepgram, if a key is added; Higgsfield or OpenAI in Creator mode, if a key is added (only the pictures and words put into Creator mode). Anything an AI assistant like Claude reads through GBrain's connector goes to that assistant.

## Testing

- **The twin:** `cl twin start` runs this same code against a scratch library on ports 4344 to 4346 (`RECALL_DATA`). Every change is tried there before the real app restarts.
- **Unit tests:** `tests/*.test.ts`, run one file at a time with `bun test`.
- **The public check:** `tools/check-public.ts` runs before every commit and in CI.

## Design notes

- [docs/nature.md](docs/nature.md): the natural systems Recall copies (streams, watershed, reservoir, delta, cells, seed bank and more), and how.
- [docs/categories.md](docs/categories.md): the tree, and how categories form.
- [docs/resurface.md](docs/resurface.md): bringing ideas back.
- [docs/end-state.md](docs/end-state.md): the end state the overnight build worked from.
- [docs/go-live.md](docs/go-live.md): going live for everyone.
- [docs/server.md](docs/server.md): moving to an always-on server.
