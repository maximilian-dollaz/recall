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

1. Check the Mac first (installs nothing):
   ```
   curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/check.sh | bash
   ```
   `✓` means go. `!` means it fits but the Mac will be fairly full: tell the person, suggest freeing space, and go on if they're fine with it. `✗` means stop: tell the person, in one plain sentence each, what the check listed (it says what to do).

   If space is short, the person runs the clean-up helper themselves in Terminal (it asks them a yes or no for each thing, so you can't answer for them, and it never removes their documents or photos): `curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/free-space.sh | bash`. Then run the check again. Never delete files yourself to make room.
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

1. **Check the Mac.** Have them open Terminal (step 2) and paste the check line from Path A step 1; it answers ✓, ! or ✗ with what to do. Or by hand: Apple menu → **About This Mac** (Chip **Apple M…**, Memory **8 GB** or more, macOS **14** or newer) and System Settings → General → **Storage** (free space: 50 GB comfortable; at least 25 GB, or 20 GB on an 8 GB Mac).
2. **Open Terminal.** Hold **⌘** and tap the **space bar**, type `Terminal`, press **Return**.
3. **Paste the line.** Give them the install command in a code block. They click inside the Terminal window, press **⌘ V**, then **Return**.
4. **Wait.** Green lines count from `[1 of 11]` to `[11 of 11]`. Tell them to keep the window open and the Mac plugged in, and to send a screenshot if red text appears or nothing changes for 30 minutes.
5. **Done** when it says `✓ Done. Recall is installed and running.` and Recall opens in the browser.

A picture guide for the person is at https://github.com/maximilian-dollaz/recall/blob/main/INSTALL.md; you may share it.

## Messages the installer can stop with

| Message | What to do |
| --- | --- |
| `The install stopped at step N: …` | Run the same command again. Usually a dropped download. |
| `✗ Recall can't be installed on this Mac yet.` | The lines below it say why. Intel chip or under 8 GB memory: stop, it can't run here. Old macOS: update, then run again. Free space: free what it says, then run again. |
| `! Recall fits, but the Mac will be fairly full.` | Not an error; the install continues. |
| `Ollama didn't start` / `The AI model didn't answer` | Restart the Mac, then run again. If it repeats, send the log. |
| `The library server didn't start` / `Recall didn't start` | Run again. If it repeats, send the log. |
| `Other library sessions are still open` | Quit Claude Code sessions using Recall's library, then run again. |

## The iPad or iPhone (after the Mac install)

Recall runs on the Mac; an iPad or iPhone uses it privately through Tailscale. On the Mac run:

```
zsh ~/Recall/connect-ipad.sh
```

It is interactive, so in Path B the person runs it. It installs Tailscale (macOS asks for the Mac's login password: the person types it into macOS's own window, never into chat), asks them to sign in to Tailscale, may open one page where they click **Enable** for HTTPS, then prints a QR code and an `https://….ts.net` address. On the iPad: install **Tailscale** from the App Store, sign in with the **same account**, open the address (scan the QR code), then Share → **Add to Home Screen**. The Mac must be on and awake for the iPad to reach it.

## Done when

- `curl -s http://localhost:3344/api/health` prints `{"ok":true,…}`, and
- http://localhost:3344 opens Recall in the browser.

---

**For the person, what to paste into your AI:**

```
Install Recall on my Mac. Read this page and follow it exactly:
https://raw.githubusercontent.com/maximilian-dollaz/recall/main/AI-INSTALL.md
```
