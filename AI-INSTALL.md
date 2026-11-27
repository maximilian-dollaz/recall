# Installing Recall on a Mac, for an AI assistant

This page is for an AI assistant installing **Recall** on a person's Mac. Recall runs fully on their Mac, with a local AI model. The person may never have used Terminal: **you run every command yourself**; they only answer questions and click Allow. Read the whole page before your first reply.

**Nothing here needs a GitHub account.** Every link below is a public download. If you are running in a cloud environment that asks the person to connect GitHub, you are in the wrong place: see "Which Claude" at the end.

## Rules

1. **Run only the commands on this page.** No `sudo`, no `brew`, no editing the person's files, no `caffeinate` (the installer keeps the Mac awake itself).
2. **Never ask for a password, key or code in the chat**, and never type one. When macOS asks for the Mac's password, the person types it into macOS's own window.
3. **Never delete or move the person's files yourself.** To free space, use `free-space.sh` below, and only for the items the person said yes to, one by one.
4. **Plain words, short messages.** Say what's happening and roughly how long. Tell the person before anything appears on their screen (an installer window, a sign-in page, "allow" prompts).
5. Long commands run **in the background with a log**, and you check the log every minute or two (your command timeout is shorter than the install).
6. If the same step fails twice, stop and give the person the log file to send to whoever shared Recall: `~/.recall/logs/install.log`.

## Step 1. Check the Mac (installs nothing)

```
curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/check.sh | bash
```

Exit code and what to do:
- **0, ✓ ready:** go to step 3.
- **3, ! fits but tight:** tell the person the Mac will be fairly full, offer step 2, then continue either way.
- **2, ✗ not enough free space** (the only problem): do step 2, then run this check again.
- **1, ✗ can't run Recall** (Intel chip, under 8 GB memory, or macOS older than 14): tell the person in one plain sentence each, using the lines it printed. Old macOS: they update (System Settings → General → Software Update), then you check again. Intel or under 8 GB: stop; Recall can't run on this Mac.

Thresholds: needs at least 25 GB free (20 GB on an 8 GB Mac); 50 GB is comfortable. Recall uses about 12 GB (8 GB on an 8 GB Mac).

## Step 2. Free up space (only if needed, only with a yes for each)

```
curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/free-space.sh -o /tmp/free-space.sh
bash /tmp/free-space.sh --list
```

It prints one line per thing that could be freed: `downloads <KB> <path>` (files over 200 MB in Downloads untouched for a month), `caches <KB>`, `trash <items>`, `free <GB>`. macOS may ask the person to let Claude see Downloads or control Finder: tell them to click OK.

Show the person the list in plain words with sizes in GB, then ask, item by item:
- Each Downloads file they want gone: `bash /tmp/free-space.sh --trash "<path>"` (moves it to the Trash; nothing is deleted yet).
- App caches (safe: apps rebuild them; suggest quitting web browsers first): `bash /tmp/free-space.sh --clear-caches`
- Emptying the Trash (this is what frees the space; it's permanent, so say so): `bash /tmp/free-space.sh --empty-trash`
- More room the Apple way (old iPhone backups, unused apps): `bash /tmp/free-space.sh --open-storage` opens Apple's Storage settings for them to look at.

Never touch Documents, Desktop, Pictures, Photos or anything else. Then run step 1 again.

## Step 3. Install (15 to 45 minutes)

Tell the person: "Installing now. It downloads the AI (4 to 9 GB), so it takes 15 to 45 minutes. Keep the Mac plugged in; you can keep using it."

Start it in the background:

```
curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/get.sh -o /tmp/recall-get.sh && RECALL_NO_OPEN=1 nohup bash /tmp/recall-get.sh > /tmp/recall-install.out 2>&1 &
```

Then every minute or two:

```
tail -5 /tmp/recall-install.out
```

Progress lines look like `[5 of 11] Downloading the AI models`. Tell the person each new step in a few words. It's finished when the output contains `✓ Done. Recall is installed and running.` (success) or `✗` (stopped). On `✗ The install stopped at step N`: run the same start command again (it continues where it stopped), at most twice.

Confirm: `curl -s http://localhost:3344/api/health` prints `{"ok":true,…}`. Then `open http://localhost:3344` to show Recall to the person. Tell them it's also **Recall** on their Desktop and starts by itself with the Mac.

## Step 4. The iPad or iPhone (if they have one)

Recall stays on the Mac; the iPad uses it privately through Tailscale (free). Tell the person what will appear, then start it in the background:

```
nohup zsh ~/Recall/connect-ipad.sh > /tmp/recall-ipad.out 2>&1 &
```

Watch `tail -15 /tmp/recall-ipad.out` and guide them through what it asks for, in this order:
1. **Tailscale's installer window** opens: they click Continue, Install, and type **the Mac's password** into that window.
2. **Tailscale sign-in**: they sign in with the Google or Apple account they'll also use on the iPad. If macOS asks to allow a VPN configuration: Allow.
3. Maybe a **Tailscale page with an Enable button** (for private https): they click Enable.
4. When the output says `✓ This Mac is ready for the iPad`, a **QR code** opens on the Mac's screen, and the output has the address (`https://….ts.net`).

On the iPad: App Store → **Tailscale** → Get → sign in with the **same account** → Allow the VPN. Then scan the QR code with the iPad's camera (or type the address in Safari), and tap **Share → Add to Home Screen**. The Mac must be on and awake for the iPad to reach Recall; suggest System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when the display is off".

## Done when

- `curl -s http://localhost:3344/api/health` prints `{"ok":true,…}`,
- Recall is open in the person's browser, and
- (if they have one) Recall is on the iPad's Home Screen.

## If you can't run commands

(ChatGPT, or Claude in a browser or on a phone.) Tell the person the easiest way is the Claude desktop app's Code tab (below), which runs all of this for them. Otherwise guide them one step at a time through the picture guide: https://github.com/maximilian-dollaz/recall/blob/main/INSTALL.md

## Which Claude

Recall installs from the **Claude desktop app for Mac → Code tab → Local** (a session that runs on the person's own Mac, in a folder they pick, such as their home folder). That needs no GitHub account.

The **Cloud** option (and claude.ai/code in a browser) runs on Anthropic's computers, not the person's Mac, and asks to connect GitHub. It can't install Recall. Switch to **Local**.

---

**For the person, what to paste into Claude:**

```
Install Recall on my Mac. Read this page and follow it exactly: https://raw.githubusercontent.com/maximilian-dollaz/recall/main/AI-INSTALL.md
```
