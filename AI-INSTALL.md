# Installing Recall on a Mac, for an AI assistant

This page is for an AI assistant (Claude, ChatGPT or another) helping a person install **Recall** on their Mac. Recall runs fully on their Mac with a local AI model. Read the whole page before your first reply.

The person may be a complete beginner. Use plain words, one step at a time, and say what they should see when it worked.

## The whole install is one command

```
curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/get.sh | bash
```

It downloads Recall into `~/Recall` and runs `~/Recall/install.sh`. It needs **no admin password, no Homebrew, no Xcode, no keys and no answers**: it never reads from the keyboard. It is safe to run again; each run continues where the last stopped and never replaces the person's library or settings. The code is public: https://github.com/maximilian-dollaz/recall (`get.sh`, `install.sh`).

## Rules

1. **Run only the commands on this page.** Never add `sudo`, `brew`, `caffeinate`, or edits to files. The installer already keeps the Mac awake.
2. **Never ask for a password, API key or code**, and never type one. If anything asks for a password, cancel it and tell the person.
3. **Don't interrupt it.** It takes 15 to 45 minutes. Step 5 of 11 (the model download, 4 to 9 GB) is the long one and shows progress bars. Silence for a few minutes during steps 2, 6 and 9 is normal.
4. If a window asks to install **command line developer tools**, click **Not Now**.
5. If the same step fails twice, stop and give the person the log file `~/.recall/logs/install.log` to send to whoever shared Recall with them.

## Path A: you can run commands on this Mac

(For example Claude Code, or the Claude desktop app with a terminal or computer use.)

1. Check the Mac: `uname -m` must print `arm64`; `sw_vers -productVersion` must be 14 or higher. If not, stop and tell the person why (Intel Mac, or update macOS first).
2. Run the install command above. Give it a timeout of at least **60 minutes**, or run it in the background and check on it, because the download is long. If your shell tool can't run that long, use Terminal through computer use instead: open Terminal, paste the command, press Return, then check the window every few minutes.
3. **It worked** when the output ends with `✓ Done. Recall is installed and running.` Confirm with:
   ```
   curl -s http://localhost:3344/api/health
   ```
   which prints `{"ok":true,…}`.
4. If it ended with `✗ The install stopped at step N`, run the same command again (at most twice). Read the lines above the red message to understand why, and tell the person in one plain sentence.
5. Tell the person: Recall is at http://localhost:3344 (and as **Recall** on their Desktop), it starts when the Mac starts, and everything they save stays on their Mac.

## Path B: you can't run commands (you're in a browser or a phone app)

Guide the person. Give **one step**, then wait for their reply or screenshot.

1. **Check the Mac.** Apple menu (top-left) → **About This Mac**. Chip must say **Apple M…**, Memory **8 GB** or more, macOS **14** or newer.
2. **Open Terminal.** Hold **⌘** and tap the **space bar**, type `Terminal`, press **Return**.
3. **Paste the line.** Give them the install command in a code block. They click inside the Terminal window, press **⌘ V**, then **Return**.
4. **Wait.** Green lines count from `[1 of 11]` to `[11 of 11]`. Tell them to keep the window open and the Mac plugged in, and to send a screenshot if red text appears or nothing changes for 30 minutes.
5. **Done** when it says `✓ Done. Recall is installed and running.` and Recall opens in the browser.

A picture guide for the person is at https://github.com/maximilian-dollaz/recall/blob/main/INSTALL.md; you may share it.

## Messages the installer can stop with

| Message | What to do |
| --- | --- |
| `The install stopped at step N: …` | Run the same command again. Usually a dropped download. |
| `needs a Mac with Apple Silicon` | Intel Mac. Recall can't run here. Stop. |
| `needs macOS 14 (Sonoma) or newer` | Update macOS (System Settings → General → Software Update), then run again. |
| `needs at least 8 GB of memory` | This Mac is too small. Stop. |
| `needs about N GB of free disk` | Free space (empty the Trash, delete large downloads), then run again. |
| `Ollama didn't start` / `The AI model didn't answer` | Restart the Mac, then run again. If it repeats, send the log. |
| `The library server didn't start` / `Recall didn't start` | Run again. If it repeats, send the log. |
| `Other library sessions are still open` | Quit Claude Code sessions using Recall's library, then run again. |

## Done when

- `curl -s http://localhost:3344/api/health` prints `{"ok":true,…}`, and
- http://localhost:3344 opens Recall in the browser.

---

**For the person, what to paste into your AI:**

```
Install Recall on my Mac. Read this page and follow it exactly:
https://raw.githubusercontent.com/maximilian-dollaz/recall/main/AI-INSTALL.md
```
